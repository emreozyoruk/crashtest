# Crashtest findings — TonyMckes/conduit-realworld-example-app

First local run, 2026-10-10 00:27 PDT. 5 scenarios selected from the 188 generated: **3 passed, 2 broken**, 151 s including booting the app from scratch.

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
