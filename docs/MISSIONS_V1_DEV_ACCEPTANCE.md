# Mission Planning V1 — DEV Acceptance

Baseline: `ac2909e7d02d589827e14709a21f9761c5d213d7`  
Status: **PENDING DEV ACCEPTANCE**

Use this checklist before closing Mission Planning V1 (M1, M2, M3). Record the DEV URL, deployed SHA, desktop browser, mobile width, test account/group, and tested Stanton, Nyx, and Pyro themes. This is a DEV-environment checklist; production behavior has not been accepted by this document.

## Primary flow

- [ ] Create a mission.
- [ ] Create a CHECKLIST task.
- [ ] Create an ITEM task with target 9.
- [ ] Assign a task.
- [ ] Reassign a task.
- [ ] Unassign a task.
- [ ] Complete and reopen the checklist task.
- [ ] Contribute 3, then the remaining 6; verify contribution history and mission completion/reopen.
- [ ] Verify mission notifications.
- [ ] Verify task notifications.
- [ ] Verify mission deep links, task deep links, refresh, and browser Back/Forward.
- [ ] Verify member removal and former-member display.
- [ ] Verify desktop and mobile layout at 680 px and 960 px.
- [ ] Verify keyboard dialog operation: initial focus, Tab/Shift+Tab loop, Escape, validation rerender, and focus return.
- [ ] Verify Stanton, Nyx, and Pyro theme switching.

## Failure flow

- [ ] Invalid mission link shows a neutral alert state.
- [ ] Stale task link stays on the mission and reports that the task is unavailable.
- [ ] Removed group or mission access shows a neutral alert state.
- [ ] API/network failure is understandable and offers the relevant retry action.
- [ ] Validation error preserves the entered dialog values.
- [ ] Over-target contribution conflict is understandable.
- [ ] No groups, no missions, no matching missions, and no tasks render correctly.

## Automated evidence

Run `node --test`; PostgreSQL lifecycle coverage requires `TEST_DATABASE_URL`. Record pass/fail/skip totals and any skipped database suites. This checklist does not claim manual acceptance was performed.
