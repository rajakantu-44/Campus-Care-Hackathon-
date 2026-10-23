# CampusCare PHP backend

This PHP backend is API-compatible with the existing frontend and uses the existing MongoDB collections without migration or data deletion:

- `administration` and `student`
- one `complaints_*` collection per department
- `counters` and `notifications`

## Requirements

- PHP 8.2+ with the official `mongodb` extension enabled
- MongoDB, with the existing `MONGO_URI` configured in the root `.env`

The root `.env` remains the source for `MONGO_URI`, `JWT_SECRET`, and configured account credentials. Existing accounts are never overwritten; only a missing configured account is created.

## Start locally

```powershell
php backend/setup.php
php -S 127.0.0.1:5000 -t frontend backend/router.php
```

Serve `frontend/` from any static server, then use the application normally. The frontend already calls `http://127.0.0.1:5000/api`.

## Thirty-day escalation job

Run the following through Windows Task Scheduler or your server's cron scheduler every six hours. It creates one Admin-001 notification for each separate 30-day stalled-status window.

```powershell
php backend/check_stale_complaints.php
```

The job is intentionally a separate CLI process: unlike a long-running Python process, normal PHP web requests should not host background timers.
