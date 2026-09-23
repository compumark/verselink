# Mission Planning V1 — DEV Acceptance

Baseline: `ac2909e7d02d589827e14709a21f9761c5d213d7`  
Status: **PENDING DEV ACCEPTANCE**

Use this checklist before closing Mission Planning V1 (M1, M2, M3). Record the DEV URL, deployed SHA, desktop browser, mobile width, and tested Stanton, Nyx, and Pyro themes.

## Primary flow

- [ ] Create a mission, a CHECKLIST task, and an ITEM task with target 9.
- [ ] Assign, reassign, and unassign a task.
- [ ] Complete and reopen the checklist task.
- [ ] Contribute 3, then remaining 6, and verify contribution history and mission completion/reopen.
- [ ] Verify mission and task notifications, mission and task deep links, refresh, and browser Back/Forward.
- [ ] Verify member removal and former-member display.
- [ ] Verify mobile layout, keyboard dialog operation, and theme switching.

## Failure flow

- [ ] Invalid mission link, stale task link, and removed access show neutral states.
- [ ] API/network failure, validation error, and over-target conflict are understandable.
- [ ] No groups, no missions, no matching missions, and no tasks render correctly.

## Automated evidence

Run `node --test`; PostgreSQL lifecycle coverage requires `TEST_DATABASE_URL`. This checklist does not claim manual acceptance was performed.
