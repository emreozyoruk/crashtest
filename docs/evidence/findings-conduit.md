# Crashtest findings — TonyMckes/conduit-realworld-example-app

## Full P1 run — 2026-10-10 01:26–02:18 PDT

Fresh analysis (latest build, new user data): **294 scenarios across 9 journeys** (114 P1 · 128 P2 · 52 P3) in 143 s. Then every P1 scenario, run locally in one go, app booted from scratch by the bootstrap agent:

**✅ 80 passed · ❌ 33 broken · ⏭ 1 skipped — 114 scenarios in 52 minutes.**

The 33 broken scenarios trace back to **12 files**. The biggest groups:

| File | Broken scenarios | What is wrong |
|---|---|---|
| `backend/middleware/authentication.js` | 9 | Any invalid, forged or expired JWT ends in a **500** (the `jwtVerify` error falls through to the generic handler) instead of a 401, and the frontend lands on "not found" instead of asking to sign in. |
| `backend/helper/jwt.js` | 5 | Tokens are signed **without an expiry** and cannot be revoked: a token keeps working after logout and after a password change. |
| `backend/controllers/user.js` | 4 | **Saving settings with a blank password replaces the user's password** — `if (password !== undefined \|\| password !== "")` is always true (`&&` was meant). Also no length check, and username/email can be changed to ones another account already uses. |
| `backend/controllers/articles.js` | 3 | Negative or non-numeric `limit`/`offset` → 500 with raw DB errors, and no cap on `limit`; renaming an article to an existing title creates a duplicate slug. |
| `backend/controllers/users.js` | 3 | Duplicate usernames are accepted at sign-up (201), duplicate-email error has the wrong shape, no rate limit on login. |

Plus: double-clicking Publish creates two articles, the Post Comment button is not disabled while posting, a user can follow themselves, and two simultaneous sign-ups with one email create two accounts.

We checked the top three against the source by hand: `controllers/user.js:36` (the `||`), `middleware/authentication.js` (errors passed to `next(error)` → 500) and `models/User.js` (`username` has no unique constraint). All three are real.

Every finding, with expected/actual, root cause at `file:line` and a suggested diff, grouped by file: **[findings-conduit-p1-full.md](findings-conduit-p1-full.md)**. Scenario list after the run: [conduit-p1-scenarios.png](conduit-p1-scenarios.png).

---

## First local run — 2026-10-10 00:27 PDT

5 scenarios selected from the 188 generated: **3 passed, 2 broken**, 151 s including booting the app from scratch.

## While booting the app
The bootstrap agent started a local Postgres 17, wrote `backend/.env` with a dev `JWT_KEY`, and found that `DEV_DB_LOGGING="false"` crashes Sequelize because the string `"false"` is truthy. It left the variable out and got the API (3001) and Vite frontend (3000) answering.

## ❌ S-118 — Delete a comment through a different article's slug (P1)
- **Observed:** comment 1 on article X; `DELETE /api/articles/<Y-slug>/comments/1` with the author's token returned `200 Comment deleted successfully` and the comment disappeared from X.
- **Root cause:** `backend/controllers/comments.js:70-79` reads `slug` from `req.params` but never uses it; the comment is looked up with `Comment.findByPk(commentId)` only.
- **Suggested fix:**
```diff
-    const comment = await Comment.findByPk(commentId);
-    if (!comment) throw new NotFoundError("Comment");
+    const article = await Article.findOne({ where: { slug } });
+    if (!article) throw new NotFoundError("Article");
+
+    const comment = await Comment.findOne({
+      where: { id: commentId, articleId: article.id },
+    });
+    if (!comment) throw new NotFoundError("Comment");
```

## ❌ S-125 — Cannot follow yourself (P1)
- **Observed:** `POST /api/profiles/<me>/follow` with my own token returned `200` with `following: true, followersCount: 1`. The profile page then rendered blank ([screenshot](conduit-S-125-profile.png)).
- **Root cause:** `backend/controllers/profiles.js:39-40` — `followToggler` never compares the logged-in user with the target profile before `profile.addFollower(loggedUser)`.
- **Suggested fix:**
```diff
     if (!profile) throw new NotFoundError("User profile");
 
+    if (profile.id === loggedUser.id)
+      return res.status(422).json({ errors: { body: ["You cannot follow yourself"] } });
+
     if (req.method === "POST") {
```

## ✅ Passed
- S-001 Register a new account with valid details
- S-002 Reject registration when email is already registered (422, message shown, stays on #/register)
- S-083 Another user cannot delete someone else's article (403, article still there)
