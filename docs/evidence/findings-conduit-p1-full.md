# Findings — Conduit (RealWorld example app)

✅ 80 passed · ❌ 33 broken · ⏭ 1 skipped · ⬜ 0 not run

## `backend/middleware/authentication.js` (9)

### S-044 [P1] Tampered JWT is rejected

**What broke:** Invalid/tampered JWT returns 500 instead of 401

- Expected: Both the tampered-payload token and the alg=none token return 401 with no user data.
- Actual: Both return HTTP 500 with {"errors":{"body":["invalid signature"]}} and {"errors":{"body":["jwt signature is required"]}}. No user data leaked.
- Root cause: backend/middleware/authentication.js:13 calls jwtVerify, which throws jsonwebtoken's JsonWebTokenError. The catch at line 27 passes it to next(error) unchanged. backend/middleware/errorHandler.js:26-28 maps anything that isn't one of the app's custom error classes to 500. The error is never converted to UnauthorizedError.

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-const { NotFoundError } = require("../helper/customErrors");
+const { NotFoundError, UnauthorizedError } = require("../helper/customErrors");
@@
-    const userVerified = await jwtVerify(token);
+    let userVerified;
+    try {
+      userVerified = await jwtVerify(token);
+    } catch (e) {
+      throw new UnauthorizedError(e.message);
+    }
     if (!userVerified) throw new Error("Invalid Token");
```

### S-046 [P1] Expired or invalid session token on a protected action

**What broke:** Invalid/garbage JWT yields HTTP 500 with raw 'invalid token' text instead of 401 and a re-login prompt

- Expected: API returns 401 for an invalid token, and the app asks the user to sign in again.
- Actual: POST /api/articles and GET /api/user returned 500. The editor showed a small red 'invalid token' message. The user stayed 'logged in' in the UI with no sign-in prompt.
- Root cause: backend/middleware/authentication.js:13 calls jwtVerify, which throws a jsonwebtoken JsonWebTokenError. The middleware passes it to next(error) at line 28. backend/middleware/errorHandler.js:11-28 only maps the custom error classes, so it falls to the generic 500 branch at line 28. The frontend also has no handling that clears the session and redirects to login on a 401 (see ArticleEditorForm.jsx:56, which only calls setErrorMessage).

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-    const userVerified = await jwtVerify(token);
-    if (!userVerified) throw new Error("Invalid Token");
+    let userVerified;
+    try {
+      userVerified = await jwtVerify(token);
+    } catch (e) {
+      throw new UnauthorizedError();
+    }
+    if (!userVerified) throw new UnauthorizedError();
@@
-    if (!req.loggedUser) next(new NotFoundError("User"));
+    if (!req.loggedUser) return next(new UnauthorizedError());
--- a/backend/middleware/authentication.js (imports)
-const { NotFoundError } = require("../helper/customErrors");
+const { UnauthorizedError } = require("../helper/customErrors");

Also, in the frontend, on a 401 clear localStorage.loggedUser and navigate to #/login.
```

### S-047 [P1] Logged-out visitor cannot use the API to act as a user

**What broke:** Forged/malformed JWT yields 500 instead of 401

- Expected: A request with a forged Authorization header 'Token abc' returns 401.
- Actual: GET and PUT /api/user with 'Token abc' return 500 {"errors":{"body":["jwt malformed"]}}. POST /api/user returns 404 because the route doesn't exist.
- Root cause: backend/middleware/authentication.js:27-29 forwards the jsonwebtoken error (JsonWebTokenError) to the generic error handler, which maps it to 500. Line 21 also lacks a `return` after next(NotFoundError), so a valid token for a deleted user hits a TypeError at line 24.

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-    if (!req.loggedUser) next(new NotFoundError("User"));
+    if (!req.loggedUser) return next(new NotFoundError("User"));
@@
   } catch (error) {
-    next(error);
+    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError" || error instanceof SyntaxError) {
+      error.status = 401;
+      error.statusCode = 401;
+    }
+    next(error);
   }
(The central error handler must also honour error.status for this to take effect.)
```

### S-083 [P1] Post a comment after the session has expired mid-read

**What broke:** Expired JWT yields HTTP 500 (and a not-found page) instead of 401 and a sign-in prompt

- Expected: An expired token gives 401, and the app prompts sign-in or redirects to login without losing the typed comment.
- Actual: The API returns 500 'jwt expired' for GET article, GET user and POST comment. The frontend lands on #/not-found, so the comment form is never shown and there is no login prompt.
- Root cause: backend/middleware/authentication.js:11 calls jwtVerify, which throws TokenExpiredError or JsonWebTokenError. The catch block at line ~27 passes it to next(error). backend/middleware/errorHandler.js:25 only maps the custom error classes, so the jsonwebtoken errors fall into the generic 500 branch. The frontend treats the failed article fetch as not-found.
- Screenshot: `.crashtest/shots/S-083/notfound.png`

```diff
--- a/backend/middleware/errorHandler.js
+++ b/backend/middleware/errorHandler.js
@@
-  if (error instanceof UnauthorizedError) {
+  if (
+    error instanceof UnauthorizedError ||
+    error.name === "TokenExpiredError" ||
+    error.name === "JsonWebTokenError"
+  ) {
     console.log(error);
 
-    res.status(401).json({ errors: { body: [error.message] } });
+    res.status(401).json({ errors: { body: [error.message] } });
   } else if (error instanceof ForbiddenError) {

Also, the frontend should redirect to #/login on a 401 and keep the draft comment.
```

### S-116 [P1] Create article with an expired token

**What broke:** Expired JWT yields 500 'jwt expired' instead of 401, and the frontend does not redirect to sign-in

- Expected: Request fails with 401; user is sent to sign-in; draft is not silently lost or published
- Actual: POST /api/articles and GET /api/user return 500. The editor shows a raw 'jwt expired' error and stays on #/editor. The expired session stays in localStorage and the user still appears logged in. The draft was not lost or published.
- Root cause: backend/middleware/authentication.js:27-29 passes the jsonwebtoken TokenExpiredError to next(error) without mapping it to 401, so the error handler returns 500. On the frontend, frontend/src/helpers/errorHandler.js:6-8 only rethrows the message, and ArticleEditorForm.jsx:54-56 only calls setErrorMessage. Nothing clears loggedUser or navigates to /login on 401.
- Screenshot: `.crashtest/shots/S-116/result.png`

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@ -27,3 +27,6 @@
   } catch (error) {
+    if (error.name === "TokenExpiredError" || error.name === "JsonWebTokenError") {
+      return res.status(401).json({ errors: { body: ["Invalid or expired token"] } });
+    }
     next(error);
   }
--- a/frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx
+++ b/frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx
@@ -54,3 +54,8 @@
     setArticle({ headers, slug, body, description, tagList, title })
       .then((slug) => navigate(`/article/${slug}`))
-      .catch(setErrorMessage);
+      .catch((msg) => {
+        if (/token|expired/i.test(String(msg))) {
+          localStorage.removeItem("loggedUser");
+          return navigate("/login", { state: { from: "/editor" } });
+        }
+        setErrorMessage(msg);
+      });
```

### S-186 [P1] Reject favorite request with an invalid or expired token

**What broke:** Invalid/expired JWT yields HTTP 500 instead of 401, and the UI lands on not-found instead of prompting sign-in

- Expected: Favorite request with an invalid or expired token returns 401, the UI doesn't show the article as favorited, and the user is prompted to sign in again.
- Actual: POST /api/articles/:slug/favorite with a bad token returns 500 {"errors":{"body":["invalid signature"]}}. GET /api/articles/:slug and GET /api/user also return 500. The SPA redirects to #/not-found with no sign-in prompt.
- Root cause: backend/middleware/authentication.js:14 calls jwtVerify, and its jsonwebtoken errors (JsonWebTokenError, TokenExpiredError) are passed to next(error) in the catch block at about line 30. backend/middleware/errorHandler.js:22 only maps the custom errors UnauthorizedError, ForbiddenError, NotFoundError and ValidationError. Everything else falls through to the generic 500. Also, backend/helper/jwt.js:5-8 signs tokens without expiresIn, so tokens never expire. The frontend has no 401 handling that clears the session or redirects to login.

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-const { NotFoundError } = require("../helper/customErrors");
+const { NotFoundError, UnauthorizedError } = require("../helper/customErrors");
@@
-    const userVerified = await jwtVerify(token);
-    if (!userVerified) throw new Error("Invalid Token");
+    let userVerified;
+    try {
+      userVerified = await jwtVerify(token);
+    } catch (e) {
+      throw new UnauthorizedError("Invalid or expired token");
+    }
+    if (!userVerified) throw new UnauthorizedError("Invalid token");

--- a/backend/helper/jwt.js
+++ b/backend/helper/jwt.js
@@
-    privateKey,
+    privateKey,
+    { expiresIn: "7d" },

The frontend should also clear the stored loggedUser and redirect to #/login when an API call returns 401.
```

### S-197 [P1] Follow request without auth header on the API

**What broke:** Malformed JWT on follow/unfollow returns 500 instead of 401

- Expected: 401 Unauthorized for a malformed token
- Actual: 500 Internal Server Error with body {"errors":{"body":["jwt malformed"]}}
- Root cause: backend/middleware/authentication.js:13 calls jwtVerify, which throws JsonWebTokenError for a bad token. The catch at line 27 passes it to next(error), and the error handler turns it into a 500. Line 21 is also missing a return after next(NotFoundError).

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-    const userVerified = await jwtVerify(token);
+    let userVerified;
+    try {
+      userVerified = await jwtVerify(token);
+    } catch (e) {
+      return res.status(401).json({ errors: { body: ["Invalid token"] } });
+    }
     if (!userVerified) throw new Error("Invalid Token");
@@
-    if (!req.loggedUser) next(new NotFoundError("User"));
+    if (!req.loggedUser) return next(new NotFoundError("User"));
```

### S-198 [P1] Favorite request with malformed authorization header

**What broke:** Malformed or wrongly-signed Bearer token on favorite returns 500 instead of 401

- Expected: Both requests return 401 and no Favorites row is created.
- Actual: Both requests return HTTP 500. The bodies are 'Token missing or malformed' and 'invalid signature'.
- Root cause: backend/middleware/authentication.js:10 throws a SyntaxError for a missing token. Line 12 lets the jsonwebtoken error (invalid signature) propagate. backend/middleware/errorHandler.js:26-28 maps every error that is not a custom error class to 500. Neither error is an UnauthorizedError, so both fall through to the 500 branch.

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-const { NotFoundError } = require("../helper/customErrors");
+const { NotFoundError, UnauthorizedError } = require("../helper/customErrors");
@@
-    if (!token) throw new SyntaxError("Token missing or malformed");
-
-    const userVerified = await jwtVerify(token);
-    if (!userVerified) throw new Error("Invalid Token");
+    if (!token) throw new UnauthorizedError();
+
+    let userVerified;
+    try {
+      userVerified = await jwtVerify(token);
+    } catch (e) {
+      throw new UnauthorizedError();
+    }
+    if (!userVerified) throw new UnauthorizedError();
```

### S-247 [P1] GET and PUT /api/user without a token or with a forged token

**What broke:** Forged or expired JWT on /api/user returns 500 instead of 401

- Expected: 401 for a token signed with the wrong secret and for an expired token
- Actual: HTTP 500 with {"errors":{"body":["invalid signature"]}} for a forged token. An expired token would go through the same path, since TokenExpiredError is also not mapped to 401.
- Root cause: backend/middleware/authentication.js:13 calls jwt.verify, which throws JsonWebTokenError or TokenExpiredError. The catch at line 27 passes it to next(error). backend/middleware/errorHandler.js:27-28 only maps the app's own UnauthorizedError to 401, so everything else becomes 500. A second bug is at authentication.js:21: next(new NotFoundError) is called without returning, and line 24 then crashes on a null loggedUser.

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-    const userVerified = await jwtVerify(token);
-    if (!userVerified) throw new Error("Invalid Token");
+    let userVerified;
+    try {
+      userVerified = await jwtVerify(token);
+    } catch (e) {
+      return next(new UnauthorizedError());
+    }
@@
-    if (!req.loggedUser) next(new NotFoundError("User"));
+    if (!req.loggedUser) return next(new NotFoundError("User"));

(also import UnauthorizedError from ../helper/customErrors)
```

## `backend/helper/jwt.js` (5)

### S-008 [P1] Your Feed with an expired token returns 401 and prompts re-login

**What broke:** Expired JWT yields 500 (not 401) on /articles/feed and /user; frontend keeps the stale session with an empty feed

- Expected: GET /api/articles/feed returns 401. The app clears the stale session or redirects to sign in.
- Actual: The API returned 500 Internal Server Error for /articles/feed and /user. The UI still shows the user as logged in, with 'Articles not available.' indefinitely. The same requests are retried repeatedly.
- Root cause: backend/helper/jwt.js:12 calls jwt.verify, which throws jsonwebtoken's TokenExpiredError. backend/middleware/authentication.js:27-28 passes it to next(error). backend/middleware/errorHandler.js:11 only maps the custom UnauthorizedError to 401, so the expired-token error falls to the generic else branch at lines 26-28 and returns 500. The frontend also has no 401 handling. frontend/src/context/AuthContext.jsx:25-27 only console.errors the failed getUser call and never clears the 'loggedUser' localStorage entry.
- Screenshot: `.crashtest/shots/S-008/feed.png`

```diff
--- a/backend/middleware/errorHandler.js
+++ b/backend/middleware/errorHandler.js
@@ -8,7 +8,10 @@
 const errorHandler = (error, req, res, next) => {
   console.log("\x1b[31m%s\x1b[0m", "▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼");
 
-  if (error instanceof UnauthorizedError) {
+  if (
+    error instanceof UnauthorizedError ||
+    error.name === "TokenExpiredError" ||
+    error.name === "JsonWebTokenError"
+  ) {
     console.log(error);
 
     res.status(401).json({ errors: { body: [error.message] } });
--- a/frontend/src/context/AuthContext.jsx
+++ b/frontend/src/context/AuthContext.jsx
@@ -25,3 +25,8 @@
     getUser({ headers })
       .then((loggedUser) => setAuthState((prev) => ({ ...prev, loggedUser })))
-      .catch(console.error);
+      .catch((err) => {
+        console.error(err);
+        localStorage.removeItem("loggedUser");
+        setAuthState(authState);
+      });
```

### S-043 [P1] Login token has no expiry and survives after the password changes

**What broke:** JWT never expires and is not invalidated after a password change

- Expected: The old token is rejected (401) after a password change, or it expires.
- Actual: GET /api/user with the pre-change token returned 200 and the user's data. The token has no exp claim.
- Root cause: backend/helper/jwt.js:5 calls jwt.sign without an expiresIn option. Nothing ties the token to the password, such as a token version or password-changed timestamp, and the auth middleware only verifies the signature.

```diff
--- a/backend/helper/jwt.js
+++ b/backend/helper/jwt.js
@@
-  jwt.sign(payload, secret)
+  jwt.sign(payload, secret, { expiresIn: '1h' })

Also add a `tokenVersion` or `passwordChangedAt` field to the user model and put it in the JWT payload. Compare it in the auth middleware and reject the token if it differs, so a password change invalidates old tokens.
```

### S-052 [P1] Old token still works after logout

**What broke:** Logout does not invalidate the JWT server-side; token is still valid after logout and never expires

- Expected: After logout, the captured token should be rejected (401). The scenario also accepted 200 as a recordable P1 gap.
- Actual: GET /api/user with the pre-logout token returned 200 and the full user object, including the token and email.
- Root cause: backend/helper/jwt.js:5 calls jwt.sign without expiresIn, and there is no revocation list or token version. Logout (frontend/src/components/Navbar/DropdownMenu.jsx:12-13, via services/userLogout) only clears client-side state and makes no server call.
- Screenshot: `.crashtest/shots/S-052/after-logout.png`

```diff
--- a/backend/helper/jwt.js
+++ b/backend/helper/jwt.js
@@ jwt.sign(payload, secret,
-  { }
+  { expiresIn: '1h' }
+// Also add POST /api/users/logout that stores the token's jti in a denylist, check the denylist in the auth middleware, and call it from userLogout.
```

### S-154 [P1] Post a comment with an expired or forged token

**What broke:** Expired or forged JWT returns 500 instead of 401

- Expected: Both requests return 401 and no comment is created
- Actual: Both return 500 with the raw jsonwebtoken message ("jwt expired" / "invalid signature"). No comment was created.
- Root cause: backend/helper/jwt.js:12 calls jwt.verify, which throws TokenExpiredError or JsonWebTokenError. verifyToken in backend/middleware/authentication.js passes the error to next(). backend/middleware/errorHandler.js:26-29 only maps the custom error classes, so these fall through to the 500 branch.

```diff
--- a/backend/middleware/errorHandler.js
+++ b/backend/middleware/errorHandler.js
@@ -10,3 +10,3 @@
-  if (error instanceof UnauthorizedError) {
+  if (
+    error instanceof UnauthorizedError ||
+    error.name === "JsonWebTokenError" ||
+    error.name === "TokenExpiredError" ||
+    error.name === "NotBeforeError"
+  ) {
     console.log(error);
```

### S-266 [P1] Get a 500 for a token with a bad signature

**What broke:** Forged JWT (bad signature) yields 500 instead of 401

- Expected: 401 Unauthorized, no user data
- Actual: 500 Internal Server Error, body {"errors":{"body":["invalid signature"]}}
- Root cause: backend/helper/jwt.js:12 calls jwt.verify, which throws JsonWebTokenError. Nothing converts it to UnauthorizedError. backend/middleware/errorHandler.js:26-28 sends any unrecognised error to the 500 branch.

```diff
--- a/backend/middleware/errorHandler.js
+++ b/backend/middleware/errorHandler.js
@@
-  if (error instanceof UnauthorizedError) {
+  if (
+    error instanceof UnauthorizedError ||
+    error.name === "JsonWebTokenError" ||
+    error.name === "TokenExpiredError" ||
+    error.name === "NotBeforeError"
+  ) {
     console.log(error);

```

## `backend/controllers/user.js` (4)

### S-239 [P1] Save settings without entering a password and keep the existing password

**What broke:** Updating settings with a blank password overwrites the user's password, so the original password stops working

- Expected: A blank password leaves the stored hash unchanged and the original password still logs in.
- Actual: PUT /api/user returned 200, but login with the original password failed with 'Wrong email/password combination'. The blank or undefined password was hashed and saved.
- Root cause: backend/controllers/user.js:36 uses `password !== undefined || password !== ""`. That condition is always true, so bcryptHash(password) runs on the blank or undefined value and the result is saved to loggedUser.password.
- Screenshot: `.crashtest/shots/S-239/after-update.png`

```diff
--- a/backend/controllers/user.js
+++ b/backend/controllers/user.js
@@ -36 +36 @@
-    if (password !== undefined || password !== "") {
+    if (password !== undefined && password !== "") {
```

### S-241 [P1] Reject a username that is already taken

**What broke:** Settings update accepts a username that is already taken

- Expected: The update is rejected with an error such as 'username is already taken', and the username stays the same in nav and after reload.
- Actual: The update succeeded with no error. Nav shows bob241, and GET /api/profiles/alice241 now returns 'not found'. Two accounts now share the username bob241.
- Root cause: backend/controllers/user.js:30-40 copies every field from the request body onto loggedUser and saves it, with no check that the username is unique. The username column in backend/models/User.js:55 is a plain STRING with no unique constraint. The same code at line 36 (`password !== undefined || password !== ""`) is always true, so a blank password field re-hashes and overwrites the password.
- Screenshot: `.crashtest/shots/S-241/after.png`

```diff
--- a/backend/controllers/user.js
+++ b/backend/controllers/user.js
@@
+    if (user.username && user.username !== loggedUser.username) {
+      const taken = await require('../models').User.findOne({ where: { username: user.username } });
+      if (taken) return res.status(422).json({ errors: { body: ['username is already taken'] } });
+    }
+
     Object.entries(user).forEach((entry) => {
@@
-    if (password !== undefined || password !== "") {
+    if (password !== undefined && password !== "") {
```

### S-242 [P1] Reject a new email already used by another account

**What broke:** PUT /api/user accepts an email already used by another account

- Expected: A 422 error naming the email as taken, and alice's email unchanged on reload
- Actual: 200 OK, alice's email saved as bob@example.com, duplicating bob's. No error is shown.
- Root cause: backend/controllers/user.js:20-46 updateUser copies every body field onto loggedUser and saves it, with no check that the email belongs to another user. backend/models/User.js:54 declares `email: DataTypes.STRING` with no unique constraint, so the database does not reject it either. The uniqueness check exists only at signup, in backend/controllers/users.js:20. Separately, user.js:35 `password !== undefined || password !== ""` is always true, so an empty password gets hashed.
- Screenshot: `.crashtest/shots/S-242/after.png`

```diff
--- a/backend/controllers/user.js
+++ b/backend/controllers/user.js
@@
+    if (user.email && user.email !== loggedUser.email) {
+      const taken = await User.findOne({ where: { email: user.email } });
+      if (taken) throw new ValidationError("Email has already been taken");
+    }
+
     Object.entries(user).forEach((entry) => {

(also import User and ValidationError at the top of user.js, and add `unique: true` to email in backend/models/User.js:54)
```

### S-243 [P1] Reject a password that is too short

**What broke:** Settings accepts a 3-character password (no length validation) and overwrites the real one

- Expected: Update is rejected with a validation error; the old password still works and abc does not sign in
- Actual: Update succeeds silently. Login with abc returns a token; login with the original goodpass123 returns 'Wrong email/password combination'.
- Root cause: backend/controllers/user.js:36 — the guard `password !== undefined || password !== ""` is always true, so any value is hashed and saved. No minimum length check exists in the controller or in the User model (backend/models/User.js:58, a plain STRING). The frontend does no check either.
- Screenshot: `.crashtest/shots/S-243/after-update.png`

```diff
--- a/backend/controllers/user.js
+++ b/backend/controllers/user.js
@@
-    if (password !== undefined || password !== "") {
-      loggedUser.password = await bcryptHash(password);
-    }
+    if (password !== undefined && password !== "") {
+      if (password.length < 8) {
+        throw new ValidationError("Password must be at least 8 characters");
+      }
+      loggedUser.password = await bcryptHash(password);
+    }

```

## `backend/controllers/articles.js` (3)

### S-003 [P1] Reject negative or non-numeric limit and offset in the list endpoint

**What broke:** Article list endpoint returns 500 with raw DB errors for negative or non-numeric limit/offset, and doesn't cap limit

- Expected: A 4xx validation error, or values clamped to a safe range. No 500, no DB error text, and a capped limit.
- Actual: limit=-1, offset=-5 and limit=abc all returned 500 with raw Postgres error text. limit=999999999 was accepted with no cap.
- Root cause: backend/controllers/articles.js:42-43 passes parseInt(limit) and offset * limit straight into Sequelize with no validation. 'abc' gives NaN and negative values reach SQL. The same pattern is at lines 132-133 in the feed handler.

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@ -26,2 +26,5 @@
-    const { author, tag, favorited, limit = 3, offset = 0 } = req.query;
+    const { author, tag, favorited } = req.query;
+    let limit = parseInt(req.query.limit ?? 3, 10);
+    let offset = parseInt(req.query.offset ?? 0, 10);
+    if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 0 || offset < 0)
+      return res.status(422).json({ errors: { body: ['limit and offset must be non-negative integers'] } });
+    limit = Math.min(limit, 100);
@@ -42,2 +45,2 @@
-      limit: parseInt(limit),
-      offset: offset * limit,
+      limit,
+      offset: offset * limit,
```

### S-121 [P1] Retitle to a title that another article already uses

**What broke:** Updating an article title to one already used by another article is accepted (200) and creates a duplicate slug

- Expected: 422 duplicate-title error; Beta keeps its title and slug 'beta'
- Actual: 200 OK. Beta's slug changed to 'alpha', which duplicates Alpha's slug. /articles/beta now returns 404, and /articles/alpha returns whichever row the database finds first.
- Root cause: backend/controllers/articles.js:192-195. The update handler sets article.slug = slugify(title) without checking whether another article already has that slug. The create handler does this check at lines 84-86 with AlreadyTakenError('Title').

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@ -191,5 +191,10 @@
     const { title, description, body } = req.body.article;
-    if (title) {
-      article.slug = slugify(title);
+    if (title && title !== article.title) {
+      const newSlug = slugify(title);
+      const slugInDB = await Article.findOne({ where: { slug: newSlug } });
+      if (slugInDB && slugInDB.id !== article.id)
+        throw new AlreadyTakenError("Title");
+      article.slug = newSlug;
       article.title = title;
     }
```

### S-274 [P1] Handle a negative or non-numeric limit and offset

**What broke:** Negative or non-numeric limit/offset on GET /api/articles causes 500; no cap on limit

- Expected: 200 with a sane result or a 422 for bad input, and a reasonable cap on limit
- Actual: limit=-1 returns 500 'LIMIT must not be negative'. offset=-5 returns 500 'OFFSET must not be negative'. limit=abc&offset=xyz returns 500 'column "nan" does not exist'. limit=100000 returns 200 with every article, because nothing caps it.
- Root cause: backend/controllers/articles.js:26 and :42-43 pass the raw query values to Sequelize with no validation. The code uses parseInt(limit) and offset * limit, which gives NaN for non-numeric input and a negative number for negative input, and nothing clamps limit. The same pattern is at lines 127-133, in the feed handler.

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@
-    const { author, tag, favorited, limit = 3, offset = 0 } = req.query;
+    const { author, tag, favorited } = req.query;
+    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 3, 1), 100);
+    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
@@
-      limit: parseInt(limit),
-      offset: offset * limit,
+      limit,
+      offset: offset * limit,
(Apply the same clamping in the feed handler near line 127.)
```

## `backend/controllers/users.js` (3)

### S-034 [P1] Reject sign up when the email is already registered

**What broke:** Duplicate-email signup returns errors.body 'Email already exists.. try logging in' instead of errors.email 'has already been taken'

- Expected: 422 with errors.email = ['has already been taken']
- Actual: 422 with {"errors":{"body":["Email already exists.. try logging in"]}}. The UI shows that text and stays on the sign-up page. No duplicate account is created.
- Root cause: backend/controllers/users.js:22 throws AlreadyTakenError('Email','try logging in'). backend/helper/customErrors.js:32-35 builds the message '<prop> already exists.. <msg>', and the error handler puts it under the generic 'body' key. There is no email field key and no 'has already been taken' text.
- Screenshot: `.crashtest/shots/S-034/result.png`

```diff
--- a/backend/helper/customErrors.js
+++ b/backend/helper/customErrors.js
@@ class AlreadyTakenError extends ValidationError {
-  constructor(property, message = "") {
-    super(`${property} already exists.. ${message}`);
+  constructor(property, message = "has already been taken") {
+    super(message);
+    this.field = property.toLowerCase();
   }
(The error handler must also emit { errors: { [err.field]: [err.message] } } for this error, and the UI errorHandler should render 'email has already been taken'.)
```

### S-042 [P1] Brute-force sign-in attempts are rate limited or at least not free

**What broke:** POST /api/users/login has no rate limiting, lockout, or CAPTCHA — brute-forceable

- Expected: Repeated failed login attempts should be throttled (HTTP 429) or the account should be temporarily locked after a reasonable number of failures.
- Actual: All 200 wrong-password POST /api/users/login requests returned HTTP 422 with no throttling (completed in ~11s, ~55ms/request, no increasing delay, no 429 ever returned). Immediately after, the 201st request with the correct password succeeded with HTTP 200 and a valid JWT, proving the account was never locked and the attacker could keep guessing indefinitely.
- Root cause: backend/controllers/users.js:41-57 (signIn) performs only a bcrypt comparison with no attempt counter, no lockout, no delay. backend/routes/users.js:8 wires POST /login directly to signIn with zero middleware. backend/index.js:15-37 sets up the Express app (cors, json) but never mounts any rate-limiting middleware (e.g. express-rate-limit) on any route, and there is no rate-limit package in backend/package.json.

```diff
--- a/backend/routes/users.js
+++ b/backend/routes/users.js
@@
 const express = require("express");
 const router = express.Router();
 const { signUp, signIn } = require("../controllers/users");
+const rateLimit = require("express-rate-limit");
+
+const loginLimiter = rateLimit({
+  windowMs: 15 * 60 * 1000, // 15 minutes
+  max: 10, // limit each IP to 10 login attempts per window
+  standardHeaders: true,
+  legacyHeaders: false,
+  message: { errors: { body: ["Too many login attempts, please try again later"] } },
+});
 
 // Register
 router.post("/", signUp);
 // Login
-router.post("/login", signIn);
+router.post("/login", loginLimiter, signIn);
 
 module.exports = router;

```

### S-272 [P1] Register with a duplicate username and get a validation error

**What broke:** POST /api/users accepts a duplicate username (201) instead of 422

- Expected: Registering with an existing username returns 422 naming 'username', and no second row is created
- Actual: POST with username 'alice' and a new email returned 201 and created a second 'alice' user. Only the duplicate email returned 422.
- Root cause: backend/controllers/users.js:19-22 only checks for an existing email (User.findOne by email, then AlreadyTakenError('Email')). There is no username check. backend/models/user.js:55 defines username as plain DataTypes.STRING with no unique constraint.

```diff
--- a/backend/controllers/users.js
+++ b/backend/controllers/users.js
@@ -22,2 +22,6 @@
     if (userExists) throw new AlreadyTakenError("Email", "try logging in");
+    const usernameExists = await User.findOne({
+      where: { username: user.username },
+    });
+    if (usernameExists) throw new AlreadyTakenError("Username", "choose another");
--- a/backend/models/user.js
+++ b/backend/models/user.js
@@ -55 +55 @@
-      username: DataTypes.STRING,
+      username: { type: DataTypes.STRING, unique: true },
```

## `frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx` (2)

### S-111 [P1] Publish a new article with tags from the editor

**What broke:** Editor tags input has no Enter-to-add behaviour; pressing Enter submits the form with only the first tag

- Expected: Pressing Enter after each tag adds it as a tag; Publish then creates the article with tagList ['javascript','testing'] and both chips show on the article page.
- Actual: Enter in the tags field submitted the form immediately after 'javascript'. The article was created with only the 'javascript' tag, and the 'testing' tag could not be entered. The article page shows one tag chip.
- Root cause: frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx:45-49 and :92-100. The tags input is a plain text field with no onKeyDown handler, so Enter triggers the form's onSubmit (line 60). tagsInputHandler only splits the raw text on commas or spaces. The `<div className="tag-list">` at line 99 is empty, so no tag chips are rendered in the editor.
- Screenshot: `.crashtest/shots/S-111/result.png`

```diff
--- a/frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx
+++ b/frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx
@@
-  const tagsInputHandler = (e) => {
-    const value = e.target.value;
-
-    setForm((form) => ({ ...form, tagList: value.split(/,| /) }));
-  };
+  const [tagInput, setTagInput] = useState("");
+  const tagsInputHandler = (e) => setTagInput(e.target.value);
+  const tagsKeyDown = (e) => {
+    if (e.key !== "Enter") return;
+    e.preventDefault();
+    const t = tagInput.trim();
+    if (t && !tagList.includes(t))
+      setForm((form) => ({ ...form, tagList: [...form.tagList, t] }));
+    setTagInput("");
+  };
@@
-          value={tagList}
-          handler={tagsInputHandler}
+          value={tagInput}
+          handler={tagsInputHandler}
+          onKeyDown={tagsKeyDown}
         >
-          <div className="tag-list"></div>
+          <div className="tag-list">
+            {tagList.map((t) => (
+              <span key={t} className="tag-default tag-pill">{t}</span>
+            ))}
+          </div>
 (initial tagList state must be [] instead of ""; FormFieldset must forward onKeyDown to the input)
```

### S-118 [P1] Double-click Publish creates only one article

**What broke:** Double-click Publish creates duplicate articles (same slug); no in-flight guard

- Expected: Exactly one article created; button disabled while request is in flight
- Actual: Two POSTs fired, both 201; two articles with identical slug exist for the author
- Root cause: frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx:51-57 formSubmit calls setArticle with no submitting state, and the button at :102 is never disabled. The backend also does not enforce slug uniqueness, so both requests succeed.
- Screenshot: `.crashtest/shots/S-118/after.png`

```diff
--- a/frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx
+++ b/frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx
@@
-  const [errorMessage, setErrorMessage] = useState("");
+  const [errorMessage, setErrorMessage] = useState("");
+  const [submitting, setSubmitting] = useState(false);
@@
     e.preventDefault();
-
+    if (submitting) return;
+    setSubmitting(true);
     setArticle({ headers, slug, body, description, tagList, title })
       .then((slug) => navigate(`/article/${slug}`))
-      .catch(setErrorMessage);
+      .catch(setErrorMessage)
+      .finally(() => setSubmitting(false));
   };
@@
-        <button className="btn btn-lg pull-xs-right btn-primary" type="submit">
+        <button className="btn btn-lg pull-xs-right btn-primary" type="submit" disabled={submitting}>
```

## `frontend/src/components/CommentEditor/CommentEditor.jsx` (2)

### S-151 [P1] Reject posting a comment with an empty body

**What broke:** Empty comment is silently ignored client-side; no request, no 422, no 'can't be blank' error shown

- Expected: POST returns 422 with body error "can't be blank"; form displays the error and keeps typed text
- Actual: Click does nothing: no POST request is made, and no error is displayed
- Root cause: frontend/src/components/CommentEditor/CommentEditor.jsx:16 `if (body.trim() === "") return;` short-circuits before postComment, and the component has no error state or rendering. Also line 20 `.then(setForm({ body: "" }))` clears the form immediately (called eagerly), so typed text isn't kept on server failure.
- Screenshot: `.crashtest/shots/S-151/after.png`

```diff
--- a/frontend/src/components/CommentEditor/CommentEditor.jsx
+++ b/frontend/src/components/CommentEditor/CommentEditor.jsx
@@
-  const [{ body }, setForm] = useState({ body: "" });
+  const [{ body }, setForm] = useState({ body: "" });
+  const [errors, setErrors] = useState(null);
@@
-    if (body.trim() === "") return;
-
     postComment({ body, headers, slug })
-      .then(updateComments)
-      .then(setForm({ body: "" }))
-      .catch(console.error);
+      .then((res) => {
+        if (res?.errors) { setErrors(res.errors); return; }
+        setErrors(null);
+        setForm({ body: "" });
+        return updateComments(res);
+      })
+      .catch(console.error);
@@
       <div className="card-block">
+        {errors?.body && <ul className="error-messages"><li>body {errors.body}</li></ul>}
         <textarea
```

### S-155 [P1] Double-click Post Comment

**What broke:** Post Comment button is not disabled while the comment request is in flight

- Expected: Button is disabled during the request; exactly one comment and one DB row
- Actual: One comment and one row, but the button stays enabled. Duplicate prevention relies only on the textarea being cleared synchronously. The cleared form is also not tied to the request result: if the request fails, the typed text is lost.
- Root cause: frontend/src/components/CommentEditor/CommentEditor.jsx:18-21 and :42. There is no submitting state. The button has no disabled attribute. `.then(setForm({body:""}))` calls setForm immediately instead of passing a callback, which is what clears the body early.
- Screenshot: `.crashtest/shots/S-155/after.png`

```diff
--- a/frontend/src/components/CommentEditor/CommentEditor.jsx
+++ b/frontend/src/components/CommentEditor/CommentEditor.jsx
@@
   const [{ body }, setForm] = useState({ body: "" });
+  const [submitting, setSubmitting] = useState(false);
@@
-    if (body.trim() === "") return;
+    if (submitting || body.trim() === "") return;
+    setSubmitting(true);
 
     postComment({ body, headers, slug })
       .then(updateComments)
-      .then(setForm({ body: "" }))
-      .catch(console.error);
+      .then(() => setForm({ body: "" }))
+      .catch(console.error)
+      .finally(() => setSubmitting(false));
@@
-        <button className="btn btn-sm btn-primary">Post Comment</button>
+        <button className="btn btn-sm btn-primary" disabled={submitting}>Post Comment</button>
```

## `backend/models/User.js` (1)

### S-037 [P1] Two simultaneous sign-ups with the same email from two tabs

**What broke:** Duplicate accounts can be created with the same email (concurrent sign-up race)

- Expected: Exactly one account per email. The second sign-up should be rejected.
- Actual: Two simultaneous registrations with the same email both returned 201 and both accounts were created.
- Root cause: backend/models/User.js:54 declares `email: DataTypes.STRING` with no `unique: true` and no DB-level unique index. Any app-level duplicate check is a check-then-insert and races under concurrent requests.

```diff
--- a/backend/models/User.js
+++ b/backend/models/User.js
@@ -54 +54 @@
-      email: DataTypes.STRING,
+      email: { type: DataTypes.STRING, allowNull: false, unique: true },

Also catch SequelizeUniqueConstraintError in the register handler and return 422. Dedupe existing rows before adding the constraint.
```

## `backend/middleware/errorHandler.js` (1)

### S-112 [P1] Reject publish when the title is empty

**What broke:** 422 validation error for missing article title is keyed under errors.body instead of errors.title

- Expected: POST /api/articles without title returns 422 with {"errors":{"title":[...]}}
- Actual: Returns 422 with {"errors":{"body":["A title is required"]}}; no errors.title key
- Root cause: backend/middleware/errorHandler.js:25 wraps every ValidationError (including FieldRequiredError thrown at backend/controllers/articles.js:80) as errors.body, with no field name. FieldRequiredError in backend/helper/customErrors.js:26 doesn't carry a field.
- Screenshot: `.crashtest/shots/S-112/result.png`

```diff
--- a/backend/middleware/errorHandler.js
+++ b/backend/middleware/errorHandler.js
@@ -25 +25 @@
-    res.status(422).json({ errors: { body: [error.message] } });
+    res.status(422).json({ errors: { [error.field || "body"]: [error.message] } });

--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@ -80 +80 @@
-    if (!title) throw new FieldRequiredError("A title");
+    if (!title) throw new FieldRequiredError("A title", "title");

(FieldRequiredError in backend/helper/customErrors.js must accept a second `field` argument and set this.field.)
```

## `frontend/src/services/setArticle.js` (1)

### S-117 [P1] Lose the network during publish

**What broke:** Publishing while offline navigates to #/article/undefined instead of showing a network error

- Expected: First click offline shows a network error and stays on #/editor with the form intact. After recovery, Publish creates exactly one article.
- Actual: The click navigated to #/article/undefined, a broken article page ('Invalid Date', empty). No error was shown and the form was lost, so retrying was not possible.
- Root cause: frontend/src/services/setArticle.js:14-16 catches the axios error and calls errorHandler(error) without rethrowing or returning an error. The promise resolves with undefined. frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx:55 then runs navigate(`/article/${slug}`) with slug undefined. The .catch(setErrorMessage) on line 56 never fires. I did not read errorHandler, so I did not confirm whether it handles errors that have no response, such as a network failure.
- Screenshot: `.crashtest/shots/S-117/offline-navigated.png`

```diff
--- a/frontend/src/services/setArticle.js
+++ b/frontend/src/services/setArticle.js
@@
   } catch (error) {
-    errorHandler(error);
+    return errorHandler(error) ?? Promise.reject(error.response?.data?.errors ?? { network: ["Network error, please try again"] });
   }
--- a/frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx
+++ b/frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx
@@
-      .then((slug) => navigate(`/article/${slug}`))
+      .then((slug) => slug && navigate(`/article/${slug}`))
```

## `frontend/src/services/userLogin.js` (1)

### S-127 [P1] Article in a stale editor after author logs out and another signs in

**What broke:** Stale editor tab keeps sending the logged-out author's token, so the article is changed after logout and a different user's login

- Expected: After A logs out and B logs in, submitting the stale editor is refused with 403 and the article stays unchanged. The editor never sends A's stale identity.
- Actual: PUT returned 200 and A's article body was overwritten. The stale tab sent A's Authorization header because it holds credentials in memory from before the logout. The request ran as A even though B is the signed-in user on the browser. The server accepted it since the token was still valid. I did not read the token in the request, so this is inferred from the 200 and from loggedUser.id equalling article.author.id.
- Root cause: The frontend captures the auth headers in React state at login (frontend/src/services/userLogin.js:13-17, AuthContext.jsx). It never re-checks localStorage or the current user before a write, so an open tab keeps A's token after another tab logs out and signs in as B. The backend (backend/controllers/articles.js:187) checks only that the token's user owns the article, and tokens are not revoked at logout, so A's old token is accepted. The ownership check is correct. The defect is stale client identity plus no logout invalidation.
- Screenshot: `.crashtest/shots/S-127/after.png`

```diff
--- a/frontend/src/context/AuthContext.jsx
+++ b/frontend/src/context/AuthContext.jsx
@@ inside AuthProvider
+  useEffect(() => {
+    const onStorage = (e) => {
+      if (e.key === 'loggedUser') {
+        const next = e.newValue ? JSON.parse(e.newValue) : { isAuth: false, headers: {}, loggedUser: {} };
+        setAuthState(next); // drops the stale token and redirects the editor
+      }
+    };
+    window.addEventListener('storage', onStorage);
+    return () => window.removeEventListener('storage', onStorage);
+  }, []);
```

## `backend/controllers/profiles.js` (1)

### S-193 [P1] Following yourself is refused

**What broke:** A user can follow themselves via POST /api/profiles/:username/follow

- Expected: 4xx rejection; no self-follow row; follower count unchanged (0)
- Actual: 200 OK, following:true, followersCount:1 on own profile
- Root cause: backend/controllers/profiles.js:39-40 calls profile.addFollower(loggedUser) without checking that loggedUser is the same user as profile.

```diff
--- a/backend/controllers/profiles.js
+++ b/backend/controllers/profiles.js
@@ -37,3 +37,6 @@
     if (!profile) throw new NotFoundError("User profile");
+    if (profile.id === loggedUser.id) {
+      return res.status(422).json({ errors: { body: ["You cannot follow yourself"] } });
+    }
 
     if (req.method === "POST") {
```
