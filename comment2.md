Follow-up: found and fixed a SECOND layer of the same visible bug on the fix branch (5cc29c6).

After merging the chains, the hook and trolley in our deck still froze while the object played its journey correctly. Cause: the hook and trolley also carry `entr/1` ENTRANCE steps on the same element. The entrance's end-cleanup timer (`delay + duration + 8ms`) fired while the merged journey's animation was still in its own delay phase and unconditionally reset the element's `cssAnimation` to `undefined`, wiping the pending journey:

```
sampled after the trigger click (post-merge, pre-guard):
  hook (pic-10):   static until ~11s, then snapped through its descend
  trolley (shape-11): static until ~9s, then snapped right
  object (group-4): 4-10s correct   <- no entrance on it, unaffected

post-guard:
  0-2s  trolley slides right (11% -> 76%)
  2-4s  hook descends onto the object (y 4 -> 41)
  4-6s  hook rises lifting the object (y 70 -> 35)
  6-8s  hook/trolley/object carry left IN SYNC (77/76/78 -> 11/11/12)
  8-10s object lowers into the crate (30 -> 65)
```

Fix: `applyAnimationGroupSteps`'s end-cleanup now skips an element whose current `cssAnimation` was replaced by a newer step (the newer step's own cleanup owns the element from there). Steps whose animation is still live keep the existing hold/clear semantics. New engine test covers the entrance + delayed-chain sequence.

Updated visual evidence (same sampling as the parent post): https://github.com/ChristopherVR/pptx-viewer/issues/353#issuecomment-<new>

Both commits are on `fix/chained-motion-path-playback` in the fork; ready to open the PR whenever you're happy with the approach.
