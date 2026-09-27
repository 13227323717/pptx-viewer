/**
 * `animation-playback-engine`: the framework-light clock + DOM glue that drives
 * a {@link PresentationAnimationController}-shaped clock (see
 * {@link PlaybackAnimationController}) during a running slide show. Extracted
 * from four near-identical copies (Vue `composables/animation-playback-helpers`,
 * Angular `viewer/presentation-playback-helpers`, Svelte
 * `presentation/animation-playback-helpers`, VanillaJS
 * `animation/animation-playback-helpers`) that had all been hand-ported from the
 * React binding's `presentation-mode/animation-helpers` + `build-playback`.
 *
 * The controller itself is pure (no DOM, no timers, no RAF) and lives in
 * {@link module:render/presentation-animation-controller}. This module owns:
 *  - applying a click-group's steps (visibility, CSS animation, sound, media
 *    command) onto a `Map<elementId, ElementAnimationState>`;
 *  - the requestAnimationFrame loop that ramps a staged chart / SmartArt build's
 *    `progress` 0 -> 1 (`p:bldChart` / `p:bldDgm`);
 *  - the auto-advance chain for consecutive withPrevious / afterPrevious groups.
 *  - (via the sibling `animation-media-end-gating`, kept separate for this
 *    file's line budget) wiring an `onStopAudio`-gated step to its REAL
 *    `<audio>`/`<video>` element's `ended` event.
 *
 * Only `window.setTimeout` / `requestAnimationFrame` / `cancelAnimationFrame` /
 * `performance.now` (all present in jsdom) and DOM lookups scoped through the
 * caller-supplied {@link PlaybackContext.frameRoot} are touched, so this stays
 * unit-testable outside a browser. Actual `Audio` playback is NOT touched here:
 * a binding wires its local sound helper in as {@link PlaybackContext.playSound}
 * / {@link PlaybackContext.stopSound} (an optional {@link PlaybackContext.onPlayActionSound}
 * host override takes priority over `playSound` when set, matching the
 * pre-extraction behaviour of `ctx.onPlayActionSound ?? playAnimationSound`).
 *
 * The `p:seq/@nextAc="seek"` nuance (a second advance while a group is still
 * mid-flight fast-forwards it to its authored end state instead of playing the
 * next group) lives in the sibling `animation-playback-seek`, whose
 * `advanceMainSequence` is the "next click" entry point every binding uses.
 *
 * @module render/animation-playback-engine
 */

import { wireMediaBookmarkSteps } from './animation-media-bookmark-gating';
import { wireMediaEndedSteps } from './animation-media-end-gating';
import { executeMediaCommandInDom } from './animation-media-playback';
import { keyframeAnimatedProperties } from './animation-parallel-composition';
import { mergeTextStyleOnStart, resolveTextStyleOnCleanup } from './animation-text-style-state';
import type { ElementAnimationState, TimelineClickGroup } from './animation-timeline-types';
import { PresentationAnimationController } from './presentation-animation-controller';
import type { PresentationStatesOptions } from './presentation-animation-controller';

/** Updater over the element-state map (React `setState`-compatible signature). */
export type StatesSetter = (
	updater: (prev: Map<string, ElementAnimationState>) => Map<string, ElementAnimationState>,
) => void;

/** Mutable handle holding the in-flight `requestAnimationFrame` id (or null). */
export interface BuildRafHandle {
	current: number | null;
}

/**
 * The subset of {@link PresentationAnimationController} this engine needs to
 * drive playback. A real controller instance satisfies this structurally, so a
 * binding passes it through unchanged; tests can pass a plain stub instead of
 * constructing a full controller from a slide.
 */
export interface PlaybackAnimationController {
	shouldAutoAdvance(): boolean;
	getAutoAdvanceDelay(): number;
	peekNext(): TimelineClickGroup | null;
	advance(nowMs?: number): TimelineClickGroup | null;
	computeStatesFor(
		elementIds: readonly string[],
		options?: PresentationStatesOptions,
	): Map<string, ElementAnimationState>;
}

/** Everything the step / build / auto-advance helpers need from the host. */
export interface PlaybackContext {
	setStates: StatesSetter;
	/** Timer ids collected here so the host can clear them on slide change. */
	timers: number[];
	buildHandle: BuildRafHandle;
	/** Host-provided action-sound player; takes priority over `playSound`. */
	onPlayActionSound?: (soundPath: string) => void;
	/** The binding's local action-sound player, used when no host override is set. */
	playSound: (soundPath: string) => void;
	/** Stops any in-progress action/animation sound. */
	stopSound: () => void;
	/** Root element to scope media-command target lookups to (the slide stage). */
	frameRoot?: () => HTMLElement | null;
	/**
	 * Maps a `p:audio`/`p:video` animation's OWN timing-tree node id to the
	 * element id it plays (`animation-media-end-gating`'s
	 * `resolveMediaTimeNodeElementIds`), so an `onStopAudio`-gated step can
	 * find the real DOM element for its `ended` event. Absent: falls back to
	 * the `delayMs` estimate alone (matches every binding before this existed).
	 */
	mediaTimeNodeElementIds?: ReadonlyMap<number, string>;
	/**
	 * ElementId -> bookmarkName -> time(ms) lookup
	 * (`animation-media-bookmark-gating`'s `resolveMediaBookmarkTimesMs`), so
	 * an `onMediaBookmark`-gated step can find the real DOM media element and
	 * the bookmark's authored time. Absent: a bookmark-gated step never fires
	 * (see `animation-media-bookmark-gating`'s module doc).
	 */
	mediaBookmarkTimesMs?: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

// ---------------------------------------------------------------------------
// Click-group step application
// ---------------------------------------------------------------------------

/** The staged-build fields of a state, carried across the step writes below. */
type BuildStateFields = Pick<
	ElementAnimationState,
	'build' | 'chartReveal' | 'diagramReveal' | 'textStyle'
>;

/**
 * The staged-build reveal a state already holds. A `p:bldChart` / `p:bldDgm`
 * build fires one step PER STAGE against the same element id, so every write
 * that replaces the element's state object (a step starting, a step's cleanup
 * timer) has to carry these through: dropping them hands the renderer a state
 * with no build at all, which it reads as "reveal everything" - the whole
 * diagram popped in the moment the first stage's fade finished.
 */
function carryBuildState(state: ElementAnimationState | undefined): BuildStateFields {
	if (!state) {
		return {};
	}
	const carried: BuildStateFields = {};
	if (state.build) {
		carried.build = state.build;
	}
	if (state.chartReveal) {
		carried.chartReveal = state.chartReveal;
	}
	if (state.diagramReveal) {
		carried.diagramReveal = state.diagramReveal;
	}
	if (state.textStyle) {
		carried.textStyle = state.textStyle;
	}
	return carried;
}

/**
 * Apply a click-group's steps onto the element-state map: fire sound / media
 * commands, set each step's initial visibility + CSS animation, then schedule
 * cleanup timers to clear the animation (and hide exits) once each step ends.
 *
 * An `onStopAudio`-gated step also gets a real `ended` listener wired via
 * `wireMediaEndedSteps` (`animation-media-end-gating`), which corrects the
 * fallback estimate below once the actual media element finishes; the
 * fallback still fires unconditionally, so no-real-media contexts
 * (export/headless) are unaffected.
 */
export function applyAnimationGroupSteps(group: TimelineClickGroup, ctx: PlaybackContext): void {
	wireMediaEndedSteps(group, ctx);
	wireMediaBookmarkSteps(group, ctx);

	// Sound + media-playback side effects.
	for (const step of group.steps) {
		if (step.command) {
			const command = step.command;
			const timer = window.setTimeout(
				() => {
					executeMediaCommandInDom(command, ctx.frameRoot);
				},
				Math.max(0, step.delayMs),
			);
			ctx.timers.push(timer);
			continue;
		}
		if (step.stopSound) {
			// A chained-motion segment's stop cue fires at its authored start
			// (see `animation-motion-path-chain`), so delay it like commands.
			if (step.delayMs > 0) {
				const stopTimer = window.setTimeout(() => {
					ctx.stopSound();
				}, step.delayMs);
				ctx.timers.push(stopTimer);
			} else {
				ctx.stopSound();
			}
		} else if (step.soundPath) {
			// Same: an animation sound belongs at its own effect's start, not
			// at the group's. delayMs 0 keeps the historical immediate fire.
			const soundPath = step.soundPath;
			if (step.delayMs > 0) {
				const soundTimer = window.setTimeout(() => {
					(ctx.onPlayActionSound ?? ctx.playSound)(soundPath);
				}, step.delayMs);
				ctx.timers.push(soundTimer);
			} else {
				(ctx.onPlayActionSound ?? ctx.playSound)(soundPath);
			}
		}
	}

	// Initial CSS-animation / visibility state. A `p:animClr` step also surfaces
	// its fill / stroke colour targets so the vector / connector renderers
	// relinquish their static paint (`inherit`) and the wrapper's colour keyframes
	// cascade in for the duration of the step.
	ctx.setStates((previous) => {
		const next = new Map(previous);
		// One click group routinely holds SEVERAL steps for the same element (a
		// crane claw that "slides right 0-2s, then fades out 2-2.5s" is one
		// authored sequence), each with its own delay. The element state holds
		// ONE CSS animation list, so those steps must ACCUMULATE into a
		// comma-joined list — the historical last-write-wins handed the element
		// only the LAST step and the claw never slid at all.
		//
		// The accumulation is per CSS PROPERTY, as a list of components: a new
		// step REPLACES only the earlier components whose properties it takes
		// over (an exit's `opacity` supersedes the entrance's fade but must not
		// touch the motion's `transform`), and appends otherwise. Two
		// animations touching one property resolve in list order, and a later
		// one's `fill: both` from-frame would pin the property through the
		// earlier one's whole active window — the freeze the chained-journey
		// merge exists to prevent — so takeover, not coexistence, is the rule.
		//
		// Components start EMPTY per pass: an animation left over from a
		// previous group or run (a held journey, a completed exit) is replaced
		// by the new pass's first step, never joined onto — replaying a
		// sequence must not glue its new motion to the old exit's held
		// `opacity: 0` and slide the element around invisible.
		interface AnimationComponent {
			animation: string;
			properties: Set<string>;
		}
		const componentsByElement = new Map<string, AnimationComponent[]>();
		for (const step of group.steps) {
			if (step.command) {
				continue;
			}
			const current = next.get(step.elementId);
			const shouldBeVisible = step.presetClass === 'exit' ? (current?.visible ?? true) : true;
			const carried = carryBuildState(current);
			let components = componentsByElement.get(step.elementId);
			if (!components) {
				components = [];
				componentsByElement.set(step.elementId, components);
			}
			if (step.cssAnimation) {
				const stepProperties = keyframeAnimatedProperties(step.keyframeName);
				// An unrecognised keyframe name claims every property (conservative
				// takeover); a recognised one that animates nothing (a no-op
				// preset) simply coexists.
				const takesOverEverything = stepProperties.has('unknown');
				for (let index = components.length - 1; index >= 0; index--) {
					const component = components[index];
					const collides =
						takesOverEverything ||
						[...stepProperties].some((property) => component.properties.has(property));
					if (collides) {
						components.splice(index, 1);
					}
				}
				components.push({ animation: step.cssAnimation, properties: stepProperties });
			}
			next.set(step.elementId, {
				...carried,
				visible: shouldBeVisible,
				cssAnimation: components.map((component) => component.animation).join(', '),
				animatesFill: step.colorTargets?.includes('fill') ? true : undefined,
				animatesStroke: step.colorTargets?.includes('stroke') ? true : undefined,
				textStyle: mergeTextStyleOnStart(carried.textStyle, step.textStyle),
			});
		}
		return next;
	});

	// Cleanup after each step completes: clear the animation, hide finished exits,
	// and drop the colour-target flags so the static paint is restored.
	for (const step of group.steps) {
		if (step.command) {
			continue;
		}
		const timer = window.setTimeout(
			() => {
				ctx.setStates((previous) => {
					const next = new Map(previous);
					const current = next.get(step.elementId);
					// A LATER-applied step may own this element's animation now: a
					// chained-motion journey (see `animation-motion-path-chain`)
					// attaches one long animation whose delay spans past this
					// step's whole window, and any followed-up effect behaves the
					// same. This step's end-cleanup must not clear a newer
					// animation that is still pending or running — wiping it
					// during the newer animation's own delay phase killed
					// delayed journeys right after their entrance fired.
					const superseded =
						current?.cssAnimation !== undefined && current.cssAnimation !== step.cssAnimation;
					if (superseded) {
						return next;
					}
					// `afterAnimation: "hideAfterAnimation"` hides the element once its
					// (entrance/emphasis) effect ends, overriding normal visibility.
					const visibleAfter =
						step.presetClass === 'exit' || step.hideAfterEffect
							? false
							: (current?.visible ?? true);
					// `p:cTn/@fill="hold"`/`"freeze"`: keep the CSS animation attached so
					// its final frame persists instead of reverting on cleanup. A
					// font-style emphasis's text-style override follows the SAME flag.
					const carried = carryBuildState(current);
					next.set(step.elementId, {
						...carried,
						visible: visibleAfter,
						cssAnimation: step.holdEndState ? step.cssAnimation : undefined,
						textStyle: resolveTextStyleOnCleanup(
							carried.textStyle,
							step.textStyle,
							step.holdEndState,
						),
					});
					return next;
				});
			},
			Math.max(0, step.delayMs + step.durationMs + 8),
		);
		ctx.timers.push(timer);
	}
}

// ---------------------------------------------------------------------------
// Staged chart / SmartArt build reveal (RAF-driven)
// ---------------------------------------------------------------------------

/** Cancel any in-flight build RAF and clear the handle. */
export function cancelBuildReveal(handle: BuildRafHandle): void {
	if (handle.current !== null && typeof cancelAnimationFrame === 'function') {
		cancelAnimationFrame(handle.current);
	}
	handle.current = null;
}

/**
 * Ramp a click-group's staged-build `progress` from 0 -> 1 via
 * requestAnimationFrame, merging each build element's `build` descriptor onto the
 * element states each frame. No-op when the group carries no build step, so
 * ordinary click-advance is unchanged.
 */
export function driveBuildReveal(
	controller: PlaybackAnimationController,
	group: TimelineClickGroup,
	ctx: PlaybackContext,
): void {
	cancelBuildReveal(ctx.buildHandle);
	const buildIds = PresentationAnimationController.collectBuildStepIds(group);
	if (buildIds.length === 0 || typeof requestAnimationFrame !== 'function') {
		return;
	}

	const start = performance.now();
	const tick = (): void => {
		const elapsedMs = performance.now() - start;
		const states = controller.computeStatesFor(buildIds, { elapsedMs });

		ctx.setStates((previous) => {
			const next = new Map(previous);
			for (const id of buildIds) {
				const computed = states.get(id);
				if (!computed?.build) {
					continue;
				}
				const existing = next.get(id) ?? { visible: true, cssAnimation: undefined };
				// The authored-index reveal set (`p:graphicEl`) rides alongside the
				// count-based `build`; both come from the same snapshot, and the
				// renderer prefers the descriptor when present.
				next.set(id, { ...existing, ...carryBuildState(computed) });
			}
			return next;
		});

		let pending = false;
		for (const id of buildIds) {
			const build = states.get(id)?.build;
			if (build && build.progress < 1) {
				pending = true;
				break;
			}
		}
		ctx.buildHandle.current = pending ? requestAnimationFrame(tick) : null;
	};

	// Seed synchronously (progress ~0) so the graphic never flashes fully built.
	tick();
}

// ---------------------------------------------------------------------------
// Play a group + auto-advance chaining
// ---------------------------------------------------------------------------

/** Apply a group's steps and start its staged-build reveal (if any). */
export function playGroup(
	controller: PlaybackAnimationController,
	group: TimelineClickGroup,
	ctx: PlaybackContext,
): void {
	applyAnimationGroupSteps(group, ctx);
	driveBuildReveal(controller, group, ctx);
}

/**
 * After a click-group plays, schedule the next group when it should auto-advance
 * (withPrevious / afterPrevious), chaining through consecutive auto-advance
 * groups.
 */
export function scheduleAutoAdvanceChain(
	controller: PlaybackAnimationController,
	ctx: PlaybackContext,
): void {
	if (!controller.shouldAutoAdvance()) {
		return;
	}
	const previousGroup = controller.peekNext();
	if (!previousGroup) {
		return;
	}
	const totalDelay = controller.getAutoAdvanceDelay() + (previousGroup.autoAdvanceDelayMs ?? 0);
	const timer = window.setTimeout(
		() => {
			const group = controller.advance();
			if (!group) {
				return;
			}
			playGroup(controller, group, ctx);
			scheduleAutoAdvanceChain(controller, ctx);
		},
		Math.max(0, totalDelay),
	);
	ctx.timers.push(timer);
}
