# Mission Planning V1 — DEV Acceptance

Baseline: `ac2909e7d02d589827e14709a21f9761c5d213d7`  
Status: **PENDING DEV ACCEPTANCE**

Use this checklist before closing Mission Planning V1 (M1, M2, M3). Record the DEV URL, deployed SHA, desktop browser, mobile width, test account/group, and tested Stanton, Nyx, and Pyro themes. This is a DEV-environment checklist; production behavior has not been accepted by this document.

## Environment

- [ ] DEV URL: ____________________
- [ ] Deployed SHA: ____________________
- [ ] Desktop browser: ____________________
- [ ] Mobile / responsive width: ____________________
- [ ] Stanton theme
- [ ] Nyx theme
- [ ] Pyro theme

## Primary flow

- [ ] Create Mission
- [ ] Create CHECKLIST task
- [ ] Create ITEM task with target 9
- [ ] Assign task
- [ ] Reassign task
- [ ] Unassign task
- [ ] Complete CHECKLIST
- [ ] Reopen CHECKLIST
- [ ] Contribute 3
- [ ] Contribute remaining 6
- [ ] Verify contribution history
- [ ] Verify Mission becomes completed
- [ ] Add new open task
- [ ] Verify Mission reopens
- [ ] Verify Mission notification
- [ ] Verify Task notification
- [ ] Verify Mission deep link
- [ ] Verify Task deep link
- [ ] Copy Mission Link
- [ ] Open copied Mission Link in fresh tab
- [ ] Copy Task Link
- [ ] Open copied Task Link in fresh tab
- [ ] Verify compact Assignment controls
- [ ] Verify compact Contribution controls
- [ ] Refresh Mission view
- [ ] Browser Back
- [ ] Browser Forward
- [ ] Remove member
- [ ] Verify former-member display
- [ ] Verify desktop layout
- [ ] Verify mobile layout
- [ ] Verify keyboard dialog operation
- [ ] Verify Stanton theme
- [ ] Verify Nyx theme
- [ ] Verify Pyro theme

## Failure flow

- [ ] Invalid Mission link
- [ ] Stale Task link
- [ ] Access removed
- [ ] API/network failure
- [ ] Validation error
- [ ] Over-target conflict
- [ ] No groups
- [ ] No Missions
- [ ] No matching Missions
- [ ] No tasks

## Automated evidence

Run `node --test`; PostgreSQL lifecycle coverage requires `TEST_DATABASE_URL`. Record pass/fail/skip totals and any skipped database suites. This checklist does not claim manual acceptance was performed.
