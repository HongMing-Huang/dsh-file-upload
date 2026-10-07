# Branch protection and the change flow

`main` is protected in a way that is deliberately **binding on administrators**,
because the first attempt at this was not. That is worth recording rather than
just configuring: the setting is easy to get subtly wrong, and the wrong version
looks identical from the UI.

## What is enforced

| Rule | Setting |
| --- | --- |
| Changes must come through a pull request | required reviews: **1 approval** |
| A new push dismisses earlier approvals | `dismiss_stale_reviews` |
| Required status checks | `build-test` (CI), `structure` (structure-guard) |
| Branch must be up to date before merging | `strict` |
| Force-pushes | blocked |
| Deleting `main` | blocked |
| **Administrators** | **bound by all of the above** (`enforce_admins`) |

## Why `enforce_admins` is the point

With `enforce_admins: false` the other rules are advisory for anyone with admin
access — including the person most likely to push. GitHub does not hide this, but
it does not stop it either. Measured on this repository:

```
remote: Bypassed rule violations for refs/heads/main:
remote: - Changes must be made through a pull request.
remote: - 2 of 2 required status checks are expected.
To https://github.com/HongMing-Huang/dsh-file-upload.git
   7183306..dadd7ac  main -> main          <- the push succeeded
```

The same push with `enforce_admins: true`:

```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: - Changes must be made through a pull request.
remote: - 2 of 2 required status checks are expected.
 ! [remote rejected] main -> main (protected branch hook declined)
```

Force-push protection was the one rule that bound administrators even in the
first configuration, which is why the rules have to be checked one by one rather
than treated as a single switch.

## The flow

1. **An issue first.** Describe the defect, the evidence, and what "fixed" means.
   Every pull request here should be able to name the issue it closes.
2. **A branch**, named for the change: `fix/<topic>-<issue>`.
3. **Commits that stand alone.** Each commit should pass `pnpm test` on its own;
   a green branch with a red commit in the middle makes `git bisect` useless.
4. **A pull request** against `main`, with the evidence in the body: what was
   wrong, how it was reproduced, how the fix was verified, and the check output.
5. **A review** from someone other than the author, then merge.

## Reviewing your own project

Solo maintainers still have to satisfy the approval rule, and GitHub does not
allow self-approval. Two workable options:

- a second account with write access reviews the change, which is what this
  repository does — the reviewer reads the diff and the evidence in the PR body,
  and approving is a real decision rather than a formality;
- if there is genuinely only one identity, lower
  `required_approving_review_count` to 0 and keep the status checks required.
  That still buys the important half: nothing reaches `main` without passing CI,
  and nothing reaches it without a pull request.

## What this does not do

Required reviews stop unreviewed *merges*, not unreviewed *work*. The reviewer
still has to read the change; a rubber stamp is the failure mode this
configuration cannot detect.

## Housekeeping note

`main` carries one empty commit, `test: probe whether main is actually
protected`. It was made while measuring the bypass above and contains no
changes. It cannot be removed by a force-push (that rule binds administrators
too) and reverting an empty commit is a no-op, so it is left in place and
recorded here rather than rewritten away. The second probe commit from the same
measurement was never pushed.
