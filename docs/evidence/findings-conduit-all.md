# Findings — Conduit (RealWorld example app)

✅ 180 passed · ❌ 104 broken · ⏭ 10 skipped · ⬜ 0 not run

## `backend/controllers/articles.js` (14)

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

### S-015 [P2] Filter by author and favorited with a nonexistent username

**What broke:** GET /api/articles?favorited=<nonexistent user> returns 500

- Expected: 200 with empty articles, or a 404
- Actual: 500 {"errors":{"body":["Cannot read properties of null (reading 'getFavorites')"]}}
- Root cause: backend/controllers/articles.js:49-52: User.findOne returns null for an unknown username, and the code calls user.getFavorites without a null check.

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@ -49,4 +49,8 @@
       const user = await User.findOne({ where: { username: favorited } });
-
-      articles.rows = await user.getFavorites(searchOptions);
-      articles.count = await user.countFavorites();
+      if (user) {
+        articles.rows = await user.getFavorites(searchOptions);
+        articles.count = await user.countFavorites();
+      }
     } else {
```

### S-031 [P3] Home feed with a very large number of articles loads within limit

**What broke:** articlesCount is inflated by the Tag join, so pagination shows many empty pages

- Expected: articlesCount equals the number of distinct articles (59), and paging to page 50 either shows articles or is not offered.
- Actual: GET /api/articles?limit=3 returns articlesCount=451 while only 59 articles exist. Pages 20 and above return an empty articles array, including offset=50.
- Root cause: backend/controllers/articles.js:26-45 calls Article.findAndCountAll with an include of the hasMany tagList association. Without distinct:true, count counts the joined tag rows rather than articles. The favorited branch at line ~50 uses user.countFavorites(), which has no such inflation, so the two branches behave differently.

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@
       limit: parseInt(limit),
       offset: offset * limit,
       order: [["createdAt", "DESC"]],
+      distinct: true,
     };
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

### S-131 [P2] Tags of two characters or fewer are dropped on publish

**What broke:** POST /api/articles response echoes unfiltered tagList including tags of 2 chars or fewer

- Expected: Response tagList contains only 'javascript'
- Actual: Response tagList is ["go","ai","javascript"]. Only the stored data is filtered, and a later GET returns ["javascript"].
- Root cause: backend/controllers/articles.js:109 sets article.dataValues.tagList = tagList, the raw request array, instead of the tags that were actually saved. The loop at lines 95-105 skips tags of length 2 or less, but only for the DB write. The check `tag.length > 2` at line 100 also runs on the untrimmed tag. An existing tag found by findByPk (line 96) is attached even if it is short.
- Screenshot: `.crashtest/shots/S-131/article.png`

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@
-    for (const tag of tagList) {
-      const tagInDB = await Tag.findByPk(tag.trim());
-
-      if (tagInDB) {
-        await article.addTagList(tagInDB);
-      } else if (tag.length > 2) {
-        const newTag = await Tag.create({ name: tag.trim() });
-
-        await article.addTagList(newTag);
-      }
-    }
+    const savedTags = [];
+    for (const raw of tagList) {
+      const name = raw.trim();
+      if (name.length <= 2) continue;
+      const [tagRow] = await Tag.findOrCreate({ where: { name } });
+      await article.addTagList(tagRow);
+      savedTags.push(name);
+    }
@@
-    article.dataValues.tagList = tagList;
+    article.dataValues.tagList = savedTags;
```

### S-132 [P2] Publish request without tagList returns an error

**What broke:** POST /api/articles without tagList returns 500 instead of 201

- Expected: Article is created with an empty tagList and the response is 201.
- Actual: 500 {"errors":{"body":["tagList is not iterable"]}}
- Root cause: backend/controllers/articles.js:79 destructures tagList with no default, and line 95 runs `for (const tag of tagList)`, which throws when tagList is undefined.
- Screenshot: `none (API-only scenario; verified via curl)`

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@ -79 +79 @@
-    const { title, description, body, tagList } = req.body.article;
+    const { title, description, body, tagList = [] } = req.body.article;
```

### S-143 [P2] Edit a published article and save it with an empty body

**What broke:** Updating an article with an empty body returns 200 instead of 422

- Expected: PUT with an empty body is rejected with 422 and a body error, and the stored body is unchanged.
- Actual: The server returned 200 OK with the unchanged article. The stored body is unchanged, but no 422 is returned and the user gets no error.
- Root cause: backend/controllers/articles.js:197 uses `if (body) article.body = body;`. An empty body is falsy, so it is skipped and the save proceeds. There is no validation on the update path. Lines 192 and 196 do the same for title and description.

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@ -191,7 +191,13 @@
     const { title, description, body } = req.body.article;
+    if (body !== undefined && String(body).trim() === "") {
+      return res.status(422).json({ errors: { body: ["can't be blank"] } });
+    }
     if (title) {
```

### S-146 [P3] Duplicate tags entered in the editor are stored once

**What broke:** Case-variant duplicate tags are stored and shown as separate chips (react + REACT)

- Expected: A single 'react' tag (or lowercase-equivalent), with no duplicate chips
- Actual: The article shows two chips, 'react' and 'REACT'.
- Root cause: backend/controllers/articles.js:95-105 uses the raw tag string: Tag.findByPk(tag.trim()) is case-sensitive and tags are never lowercased or de-duplicated. The frontend, at ArticleEditorForm.jsx:48, only splits on /,| / with no normalising. The response also returns the unnormalised tagList at line 109.
- Screenshot: `.crashtest/shots/S-146/article.png`

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@ -92,3 +92,6 @@
     });
 
-    for (const tag of tagList) {
+    const uniqueTags = [...new Set((tagList || []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
+    for (const tag of uniqueTags) {
       const tagInDB = await Tag.findByPk(tag.trim());
@@ -108,3 +111,3 @@
 
-    article.dataValues.tagList = tagList;
+    article.dataValues.tagList = uniqueTags;
```

### S-147 [P3] Deleted article's tag disappears from the tag list if unused

**What broke:** Orphaned tag 'uniquetag' remains in tag list after its only article is deleted

- Expected: After the only article using 'uniquetag' is deleted, the tag no longer appears in the popular tags list.
- Actual: GET /api/tags still returns 'uniquetag' after the delete. Clicking it gives an empty feed, with no error.
- Root cause: backend/controllers/articles.js:227 only calls article.destroy(). That removes the join rows but leaves the Tag row. backend/routes/tags.js:9 returns Tag.findAll() with no check for tags that have articles.

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@ -224,5 +224,10 @@
+    const tags = await article.getTagList();
     await article.destroy();
+    for (const t of tags) {
+      if ((await t.countArticles()) === 0) await t.destroy();
+    }
 (Note: the association name for Tag->Article may differ; check backend/models. Alternatively, in routes/tags.js filter tags to those with at least one article.)
```

### S-229 [P2] Author with more articles than one page paginates the profile list

**What broke:** Articles API treats `offset` as a page index (offset*limit) and the profile page uses a default page size of 3

- Expected: Pagination shows 3 pages of 10; page 3 shows 5 articles; GET /api/articles?author=alice&limit=10&offset=20 returns 5 articles with articlesCount 25.
- Actual: The API call with offset=20 returned [] (articlesCount 25). The offset is multiplied by limit, so it skips 200 rows. The profile page showed 9 pages of 3 articles each.
- Root cause: backend/controllers/articles.js:43 uses `offset: offset * limit`, and line 133 does the same for the feed. The RealWorld spec defines offset as a row count, not a page number. The default `limit = 3` at lines 26 and 127 also gives the 3-per-page UI. The frontend probably passes a page index as offset, so it relies on this behaviour.

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@ -43 +43 @@
-      offset: offset * limit,
+      offset: Number(offset),
@@ -133 +133 @@
-      offset: offset * limit,
+      offset: Number(offset),

The frontend must also pass offset=(page-1)*limit and use a page size of 10.
```

### S-233 [P3] Favorited tab paginates correctly when favorites exceed page size

**What broke:** Favorited tab paginates at 3 per page (4 pages for 12 favorites) instead of 10 + 2

- Expected: Page 1 shows 10 favorites and page 2 shows 2, with no duplicates and counts matching the API total of 12.
- Actual: The favorites tab shows 3 articles on page 1 and renders 4 page links for 12 favorites. The frontend sends no limit, so the backend default of 3 applies. A direct API call with limit=10 returns 10 and 2 correctly. Separately, usernames are not unique, so a duplicate 'alice' can hide an existing user's favorites.
- Root cause: backend/controllers/articles.js:26 defaults limit to 3. Line 43 sets offset: offset * limit, so offset is treated as a page index. The frontend does not pass limit, so it gets the 3-per-page default. Separately, backend/models/User.js:55 declares username without unique: true, so duplicate usernames are allowed.
- Screenshot: `.crashtest/shots/S-233/bob-p1.png`

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
-    const { author, tag, favorited, limit = 3, offset = 0 } = req.query;
+    const { author, tag, favorited, limit = 10, offset = 0 } = req.query;
--- a/backend/models/User.js
+++ b/backend/models/User.js
-      username: DataTypes.STRING,
+      username: { type: DataTypes.STRING, unique: true },
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

### S-280 [P2] Drop short tags of 2 or fewer characters when creating an article

**What broke:** POST /api/articles response echoes the unfiltered tagList, including tags of 2 or fewer characters

- Expected: The response contains only ['abc']
- Actual: The POST response has tagList ['a','ab','abc','  ']. A later GET returns ['abc'], so the two disagree.
- Root cause: backend/controllers/articles.js:109 sets article.dataValues.tagList = tagList, which is the raw request input. Tags are filtered only at lines 95-105. The length check at line 100 uses the untrimmed tag, so '  ' has length 2 and is not saved. It also runs only after Tag.findByPk, so an existing short tag would still be attached.

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@
-    for (const tag of tagList) {
-      const tagInDB = await Tag.findByPk(tag.trim());
-
-      if (tagInDB) {
-        await article.addTagList(tagInDB);
-      } else if (tag.length > 2) {
-        const newTag = await Tag.create({ name: tag.trim() });
-
-        await article.addTagList(newTag);
-      }
-    }
+    const cleanTags = [...new Set((tagList || []).map((t) => String(t).trim()))].filter((t) => t.length > 2);
+    for (const name of cleanTags) {
+      const [tagRow] = await Tag.findOrCreate({ where: { name } });
+      await article.addTagList(tagRow);
+    }
@@
-    article.dataValues.tagList = tagList;
+    article.dataValues.tagList = cleanTags;
```

### S-290 [P2] Two concurrent requests creating articles with the same slug

**What broke:** Concurrent article creation with the same title produces duplicate slugs (check-then-insert race)

- Expected: One article saved; the others get a clean 422 for duplicate slug; no duplicate slugs
- Actual: 3 parallel requests all returned 201, and GET /api/articles lists the same slug 3 times
- Root cause: backend/controllers/articles.js:85-93 does findOne for the slug and then Article.create. The two steps are not atomic. backend/models/article.js:46 declares slug as a plain STRING with no unique constraint, so the database accepts duplicates.

```diff
--- a/backend/models/article.js
+++ b/backend/models/article.js
-      slug: DataTypes.STRING,
+      slug: { type: DataTypes.STRING, unique: true },
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
-    const article = await Article.create({
+    let article;
+    try { article = await Article.create({
       slug: slug,
       title: title,
       description: description,
       body: body,
-    });
+    }); } catch (e) {
+      if (e.name === 'SequelizeUniqueConstraintError') throw new AlreadyTakenError('Title');
+      throw e;
+    }
```

## `backend/middleware/authentication.js` (14)

### S-026 [P2] Malformed Authorization header on the list endpoint is handled

**What broke:** Malformed Authorization header on /api/articles returns 500 instead of guest 200 or 401

- Expected: 200 as guest, or 401. Never 500.
- Actual: HTTP 500 {"errors":{"body":["jwt malformed"]}} for both headers. The internal jsonwebtoken error message is exposed to the caller.
- Root cause: backend/middleware/authentication.js:13 calls jwtVerify, which throws a JsonWebTokenError for a malformed token. The catch at line 27 passes it to next(error). backend/middleware/errorHandler.js:26-28 only maps the custom error types, so any other error becomes a 500 with error.message. Line 11 also throws a plain SyntaxError for a missing token, which likewise becomes a 500. Line 21 calls next(NotFoundError) without returning, so execution continues to line 23 and throws a TypeError on the null loggedUser.

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@ -1,2 +1,2 @@
-const { NotFoundError } = require("../helper/customErrors");
+const { NotFoundError, UnauthorizedError } = require("../helper/customErrors");
@@ -10,5 +10,9 @@
-    if (!token) throw new SyntaxError("Token missing or malformed");
+    if (!token) throw new UnauthorizedError("Token missing or malformed");
 
-    const userVerified = await jwtVerify(token);
-    if (!userVerified) throw new Error("Invalid Token");
+    let userVerified;
+    try {
+      userVerified = await jwtVerify(token);
+    } catch (e) {
+      throw new UnauthorizedError("Invalid Token");
+    }
@@ -21,1 +25,1 @@
-    if (!req.loggedUser) next(new NotFoundError("User"));
+    if (!req.loggedUser) return next(new NotFoundError("User"));

```

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

### S-088 [P2] Show a logged-in user a stale token response without leaking data

**What broke:** Expired or invalid JWT makes public article GET return 500, and the UI shows a misleading 404 Not Found page

- Expected: The article loads for public reading, or the app redirects cleanly to sign-in. The expired token is rejected with 401, and the stale session is cleared.
- Actual: GET /api/articles/:slug and GET /api/user return 500 {"errors":{"body":["invalid token"]}}. The SPA navigates to #/not-found and shows "404 Not Found". The stale loggedUser stays in localStorage.
- Root cause: backend/middleware/authentication.js:13 calls jwtVerify, which throws jsonwebtoken's TokenExpiredError or JsonWebTokenError. The catch at line 27 passes it to backend/middleware/errorHandler.js:26-28, which only maps the custom errors, so everything else becomes 500. The optional-auth middleware also fails the request instead of treating the caller as anonymous. The frontend (AuthContext.jsx:10-35) never clears the stored session on a failed getUser.
- Screenshot: `.crashtest/shots/S-088/expired-article.png`

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
 
     res.status(401).json({ errors: { body: [error.message] } });

Also in the frontend, clear the stored session on a 401 so the user is logged out cleanly:
--- a/frontend/src/context/AuthContext.jsx
+++ b/frontend/src/context/AuthContext.jsx
@@
       .then((loggedUser) => setAuthState((prev) => ({ ...prev, loggedUser })))
-      .catch(console.error);
+      .catch((e) => {
+        if (e?.response?.status === 401) {
+          localStorage.removeItem("loggedUser");
+          setAuthState(authState);
+        }
+      });
```

### S-098 [P2] Call GET article with a malformed Authorization header

**What broke:** Malformed Authorization header on optional-auth GET article returns 500 instead of 200/401

- Expected: 200 as anonymous, or 401 consistently; never 500
- Actual: HTTP 500 {"errors":{"body":["jwt malformed"]}} for 'Token not-a-jwt' and "Bearer ''"; 500 'Token missing or malformed' for a bare scheme
- Root cause: backend/middleware/authentication.js:11-14 throws a generic SyntaxError/Error, and jwtVerify rejects with jwt's JsonWebTokenError. backend/middleware/errorHandler.js:26-28 maps every error that is not a custom error class to 500. The same middleware at line 21 also lacks a `return` after next(NotFoundError), so a valid token for a deleted user would crash at line 24.

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-const { NotFoundError } = require("../helper/customErrors");
+const { NotFoundError, UnauthorizedError } = require("../helper/customErrors");
@@
-    if (!token) throw new SyntaxError("Token missing or malformed");
+    if (!token) throw new UnauthorizedError("Token missing or malformed");
 
-    const userVerified = await jwtVerify(token);
-    if (!userVerified) throw new Error("Invalid Token");
+    let userVerified;
+    try {
+      userVerified = await jwtVerify(token);
+    } catch (e) {
+      throw new UnauthorizedError("Invalid Token");
+    }
+    if (!userVerified) throw new UnauthorizedError("Invalid Token");
@@
-    if (!req.loggedUser) next(new NotFoundError("User"));
+    if (!req.loggedUser) return next(new NotFoundError("User"));
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

### S-255 [P2] Settings page loads for a session whose token has expired

**What broke:** Expired JWT yields 500 instead of 401; settings page keeps showing stale user as signed in

- Expected: Stale data not shown as a live session; redirect to sign-in or session-expired message; save returns 401
- Actual: Settings page renders with the stale user data and logged-in nav. The API returns 500 'jwt expired' for /api/user and the save. No redirect or message appears.
- Root cause: backend/middleware/authentication.js:13 calls jwtVerify, which throws jsonwebtoken's TokenExpiredError. It is passed to next(error) and backend/middleware/errorHandler.js falls through to the generic else branch and returns 500, since it only maps the custom UnauthorizedError to 401. The frontend (frontend/src/context/AuthContext.jsx:29-31) only does console.error on getUser failure. It keeps the localStorage session with isAuth true and never clears it.
- Screenshot: `.crashtest/shots/S-255/settings.png`

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-    const userVerified = await jwtVerify(token);
+    let userVerified;
+    try {
+      userVerified = await jwtVerify(token);
+    } catch (e) {
+      return next(new UnauthorizedError(e.message));
+    }
--- a/frontend/src/context/AuthContext.jsx
+++ b/frontend/src/context/AuthContext.jsx
@@
-      .catch(console.error);
+      .catch((err) => {
+        console.error(err);
+        localStorage.removeItem("loggedUser");
+        setAuthState(authState);
+      });
(also import UnauthorizedError from ../helper/customErrors in authentication.js)
```

### S-277 [P2] Reject a request with a malformed Authorization header by treating it as a guest

**What broke:** Malformed Authorization header returns HTTP 500 instead of 401/422

- Expected: A 401 or 422 error body for each malformed header, with no crash and no other user's data
- Actual: All three requests return HTTP 500 with {"errors":{"body":["Token missing or malformed"]}}
- Root cause: backend/middleware/authentication.js:11 throws a plain SyntaxError when the header has no token part. backend/middleware/errorHandler.js:11-29 only maps the custom error classes to 4xx, so the SyntaxError falls through to the generic 500 branch.

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-const { NotFoundError } = require("../helper/customErrors");
+const { NotFoundError, UnauthorizedError } = require("../helper/customErrors");
@@
-    if (!token) throw new SyntaxError("Token missing or malformed");
+    if (!token) throw new UnauthorizedError("Token missing or malformed");
```

## `backend/controllers/users.js` (10)

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

### S-054 [P2] Reject sign up with a malformed email address

**What broke:** Sign up accepts malformed emails (validation gap)

- Expected: 422 validation error and no account created for malformed emails
- Actual: 201 Created with a token for 'not-an-email', 'a b@x.com' and '@example.com'; accounts were created
- Root cause: backend/controllers/users.js:16 only checks that email is present (`if (!email) throw FieldRequiredError`). No format check is done there. I did not confirm whether the User model has an isEmail validator, but the 201 responses show none is enforced.

```diff
--- a/backend/controllers/users.js
+++ b/backend/controllers/users.js
@@ -16,2 +16,4 @@
     if (!email) throw new FieldRequiredError(`An email`);
+    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
+      throw new ValidationError("Email is invalid");

```

### S-056 [P2] Sign up twice quickly by double-clicking the submit button

**What broke:** Double-click on Sign up creates duplicate accounts with the same email

- Expected: One account is created. The second request gets a 422 'email already taken' or is ignored.
- Actual: Both POST /api/users returned 201. The Users table has two rows with email dblclick@example.com (ids 136 and 137).
- Root cause: backend/controllers/users.js:19-30 does a findOne on email and then User.create, with no transaction or lock, so concurrent requests both pass the check. The email column has no unique constraint (backend/migrations/20220129140956-create-user.js:10-12), so the database accepts both rows. The frontend register form also does not disable the submit button while a request is in flight.
- Screenshot: `.crashtest/shots/S-056/after.png`

```diff
--- a/backend/migrations/<new>-unique-user-email.js
+++ b/backend/migrations/<new>-unique-user-email.js
+module.exports = {
+  up: (q) => q.addConstraint('Users', { fields: ['email'], type: 'unique', name: 'users_email_unique' }),
+  down: (q) => q.removeConstraint('Users', 'users_email_unique'),
+};
--- a/backend/controllers/users.js
+++ b/backend/controllers/users.js
@@ catch (error) {
+    if (error.name === 'SequelizeUniqueConstraintError') return next(new AlreadyTakenError('Email', 'try logging in'));

Also disable the Sign up button while the request is pending in the frontend register form.
```

### S-057 [P2] Sign in with the email in a different letter case

**What broke:** Sign-in and sign-up treat email as case-sensitive; different-case email gets 404

- Expected: Sign-in with alice@example.com or ALICE@EXAMPLE.COM succeeds for an account registered as Alice@Example.com.
- Actual: POST /api/users/login returns 404 'Email not found sign in first' for both lower and upper case variants. Only the exact stored case returns 200. Sign-up uses the same exact-match lookup, so the same person can register twice with different case.
- Root cause: backend/controllers/users.js:45 (signIn) and :19-21 (signUp) look up User by the raw email. Emails are neither normalized nor compared case-insensitively. SQLite/Postgres string matching is case-sensitive here.

```diff
--- a/backend/controllers/users.js
+++ b/backend/controllers/users.js
@@ signUp
-    const userExists = await User.findOne({
-      where: { email: req.body.user.email },
-    });
+    const normEmail = email.trim().toLowerCase();
+    const userExists = await User.findOne({ where: { email: normEmail } });
@@
-      email: email,
+      email: normEmail,
@@ signIn
-    const existentUser = await User.findOne({ where: { email: user.email } });
+    const existentUser = await User.findOne({
+      where: { email: String(user.email).trim().toLowerCase() },
+    });

(Existing mixed-case rows need a one-off migration to lowercase.)
```

### S-058 [P2] Submit the login form with empty fields

**What broke:** Login with missing email/password returns 500 with an internal Sequelize error instead of 422

- Expected: 422 with a validation message for empty or missing credentials
- Actual: 500 {"errors":{"body":["WHERE parameter \"email\" has invalid \"undefined\" value"]}}. The UI shows no validation message on an empty submit.
- Root cause: backend/controllers/users.js:43-45 signIn doesn't validate user.email or user.password before User.findOne({where:{email: undefined}}). Sequelize throws and the error handler maps it to 500. signUp validates at line 16 with FieldRequiredError, but signIn does not. If req.body.user is missing, line 45 throws a TypeError.
- Screenshot: `.crashtest/shots/S-058/empty.png`

```diff
--- a/backend/controllers/users.js
+++ b/backend/controllers/users.js
@@ -42,6 +42,9 @@
   try {
-    const { user } = req.body;
+    const user = req.body && req.body.user;
+    if (!user || !user.email) throw new FieldRequiredError("An email");
+    if (!user.password) throw new FieldRequiredError("A password");
 
     const existentUser = await User.findOne({ where: { email: user.email } });
```

### S-069 [P3] Sign in is not possible for a user who has no password set

**What broke:** Login for a user with a null password returns 500 instead of 422

- Expected: 422 with a validation error, no crash, no token
- Actual: HTTP 500 with the body {"errors":{"body":["data and hash arguments required"]}}, which is an internal bcrypt error message
- Root cause: backend/controllers/users.js:48 passes existentUser.password (null) straight to bcrypt.compare (backend/helper/bcrypt.js:8). bcrypt throws 'data and hash arguments required', and the error handler turns that into a 500. Nothing checks for a missing password or hash first.

```diff
--- a/backend/helper/bcrypt.js
+++ b/backend/helper/bcrypt.js
@@
 module.exports.bcryptCompare = async (password, hasPwd) => {
+  if (!password || !hasPwd) return false;
   return bcrypt.compare(password, hasPwd);
 };
```

### S-070 [P3] Sign up with a Unicode and whitespace-padded email

**What broke:** Email is not trimmed on signup, so the padded account cannot sign in with the trimmed email

- Expected: Email is trimmed on save so sign-in with 'bob@example.com' works, or the padded email is rejected at signup.
- Actual: Signup stores '  bob@example.com  ' as-is and returns 200. Login with 'bob@example.com' fails with 'Wrong email/password combination'. Only the padded string logs in.
- Root cause: backend/controllers/users.js:25 saves the email untrimmed (email: email). backend/controllers/users.js:45 looks it up with an exact match. backend/models/User.js:54 has no trim or validation on email.

```diff
--- a/backend/controllers/users.js
+++ b/backend/controllers/users.js
@@ -14,1 +14,2 @@
-    const { username, email, bio, image, password } = req.body.user;
+    const { username, bio, image, password } = req.body.user;
+    const email = req.body.user.email?.trim();
@@ -20,1 +21,1 @@
-      where: { email: req.body.user.email },
+      where: { email },
@@ -45,1 +46,1 @@
-    const existentUser = await User.findOne({ where: { email: user.email } });
+    const existentUser = await User.findOne({ where: { email: user.email?.trim() } });
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

### S-279 [P2] Return 422 for a registration with a malformed email

**What broke:** Registration accepts malformed email addresses (no format validation)

- Expected: 422 with an error body naming the email field; no user created
- Actual: A fresh signup with email 'bad-two' returned 201 and created the user. The 422 seen for 'not-an-email' came from the duplicate-email check, and its body doesn't mention a format problem.
- Root cause: backend/controllers/users.js:14-30 (signUp) only checks that email is present and unique. There is no email format check, and the User model has no isEmail validator.

```diff
--- a/backend/controllers/users.js
+++ b/backend/controllers/users.js
@@ -16,2 +16,5 @@
     if (!email) throw new FieldRequiredError(`An email`);
+    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
+      throw new ValidationError("email is invalid");
     if (!password) throw new FieldRequiredError(`A password`);
```

## `backend/helper/jwt.js` (6)

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

### S-226 [P2] Expired token on profile page degrades gracefully

**What broke:** Expired JWT makes public endpoints return 500, so the profile page redirects to 404 with no re-login prompt

- Expected: The profile loads publicly. Clicking Follow returns 401 and the UI prompts the user to log in again.
- Actual: GET /api/profiles/alice, /api/articles?author=alice and /api/user all return 500. The profile page redirects to #/not-found and shows '404 Not Found'. Follow is never reachable.
- Root cause: backend/helper/jwt.js:12 uses jwt.verify, which throws TokenExpiredError. backend/middleware/authentication.js:25 passes it to next(error). backend/middleware/errorHandler.js:25 falls into the generic else branch and returns 500, because only the custom UnauthorizedError maps to 401. On the frontend, frontend/src/components/AuthorInfo/AuthorInfo.jsx:23-26 treats any getProfile failure as not-found and navigates to /not-found. Nothing handles 401 by clearing the stored session or prompting login.
- Screenshot: `.crashtest/shots/S-226/profile-expired.png`

```diff
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-  } catch (error) {
-    next(error);
+  } catch (error) {
+    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
+      return next(new UnauthorizedError('Token expired or invalid'));
+    }
+    next(error);
   }
--- a/backend/middleware/authentication.js
+++ b/backend/middleware/authentication.js
@@
-const { NotFoundError } = require('../helper/customErrors');
+const { NotFoundError, UnauthorizedError } = require('../helper/customErrors');

Also, for public GET routes, ignore an invalid token (call next() without setting req.loggedUser) so the profile still loads. In the frontend, handle a 401 in errorHandler or toggleFollow by calling userLogout and navigating to /login. In AuthorInfo.jsx, only navigate to /not-found on a 404.
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

## `backend/controllers/user.js` (5)

### S-239 [P1] Save settings without entering a password and keep the existing password

**What broke:** Saving settings with a blank password overwrites the stored password, so the original password stops working

- Expected: A blank password leaves the existing password untouched, and logging in with the original password still works.
- Actual: The update re-hashes the blank or undefined password and saves it. Login with the original password then fails with 'Wrong email/password combination'.
- Root cause: backend/controllers/user.js:36 uses `password !== undefined || password !== ""`. This is always true, so line 37 always runs bcryptHash on the blank or undefined password and replaces the stored hash.
- Screenshot: `.crashtest/shots/S-239/after-update.png`

```diff
--- a/backend/controllers/user.js
+++ b/backend/controllers/user.js
@@ -36,1 +36,1 @@
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

### S-258 [P2] Two tabs saving different settings at once

**What broke:** Saving Settings with a blank password field overwrites the user's password with a hash of the empty string

- Expected: A blank password field leaves the password unchanged. Settings saves from either tab only change profile fields, and the user can still log in afterwards.
- Actual: The PUT /api/user body was {bio:"A",image:"",password:"",...}. After the saves, login with the original password failed with "Wrong email/password combination".
- Root cause: backend/controllers/user.js:36 uses `password !== undefined || password !== ""`, which is always true. The empty string is therefore hashed and stored at line 37. The frontend always sends password (SettingsForm.jsx:37), so every Settings save resets the password.

```diff
--- a/backend/controllers/user.js
+++ b/backend/controllers/user.js
@@ -36,3 +36,3 @@
-    if (password !== undefined || password !== "") {
+    if (password !== undefined && password !== "") {
       loggedUser.password = await bcryptHash(password);
     }
```

## `backend/models/User.js` (4)

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

### S-055 [P2] Sign up with an extremely long username, bio and password

**What broke:** Signup has no length validation: oversized input gives 500s and a 100k password is accepted

- Expected: 4xx rejection (400/413/422) for oversized username, password and bio. No 500s, and no oversized record stored.
- Actual: Username of 10,000 chars returned 500 (DB varchar(255) error leaked). Bio of 1 MB returned 500 (body-parser 413 turned into 500). Password of 100,000 chars returned 201 and the user was created.
- Root cause: backend/models/User.js:55-58 defines username and password as DataTypes.STRING with no len validators, and bio as TEXT with no limit. backend/index.js:17 uses express.json() with the default limit, and the error handler turns every error into 500 (backend/index.js:23 area). No input validation exists in the signup route.

```diff
--- a/backend/models/User.js
+++ b/backend/models/User.js
-      username: DataTypes.STRING,
+      username: { type: DataTypes.STRING, validate: { len: [1, 50] } },
-      bio: DataTypes.TEXT,
+      bio: { type: DataTypes.TEXT, validate: { len: [0, 1000] } },
-      password: DataTypes.STRING,
+      password: DataTypes.STRING, // also validate req.body.user.password length (8..128) in the signup route before hashing
--- a/backend/index.js
+++ b/backend/index.js
-app.use(express.json());
+app.use(express.json({ limit: '100kb' }));
+// error handler: use err.status || (err.name === 'SequelizeValidationError' ? 422 : 500)
```

### S-251 [P2] Reject a malformed email in Settings

**What broke:** Settings accepts and saves a malformed email (PUT /api/user returns 200, not 422)

- Expected: A validation error is shown, nothing is saved, and the API responds 422 for an invalid email.
- Actual: PUT /api/user returned 200 with email "not-an-email". The UI showed no error. The account is now unusable: GET /api/user returns 404 "User not found".
- Root cause: backend/models/User.js:54 declares email as plain DataTypes.STRING with no isEmail validation. backend/controllers/user.js:30-34 copies every body field onto the user with no validation, then saves at line 40. The frontend also does not validate the email format. Also, line 36 `password !== undefined || password !== ""` is always true, so bcryptHash runs even when no password is sent.
- Screenshot: `.crashtest/shots/S-251/result.png`

```diff
--- a/backend/models/User.js
+++ b/backend/models/User.js
@@ -54 +54 @@
-      email: DataTypes.STRING,
+      email: { type: DataTypes.STRING, allowNull: false, unique: true, validate: { isEmail: true } },
--- a/backend/controllers/user.js
+++ b/backend/controllers/user.js
@@ -36 +36 @@
-    if (password !== undefined || password !== "") {
+    if (password !== undefined && password !== "") {

Also map Sequelize ValidationError to a 422 response in the error handler.
```

### S-259 [P2] Two users change to the same username at the same time

**What broke:** Concurrent username change to the same name lets both users succeed (duplicate usernames); update without password returns 500

- Expected: Exactly one request succeeds; the other gets a uniqueness error (422); no 500; no duplicate usernames
- Actual: Both PUT /api/user calls returned 200 with username 'bobrace2' (and again with 'bobrace3'). A body without a password returned 500 'data and salt arguments required'.
- Root cause: backend/models/User.js:54-58 declares no unique constraint on username, and backend/controllers/user.js:30-34 never checks whether the name is taken, so concurrent updates both pass. Separately, backend/controllers/user.js:36 uses `password !== undefined || password !== ""`, which is always true, so bcryptHash(undefined) throws and returns a 500 when the password is omitted.

```diff
--- a/backend/models/User.js
+++ b/backend/models/User.js
-      username: DataTypes.STRING,
+      username: { type: DataTypes.STRING, unique: true },
--- a/backend/controllers/user.js
+++ b/backend/controllers/user.js
-    if (password !== undefined || password !== "") {
+    if (password !== undefined && password !== "") {
       loggedUser.password = await bcryptHash(password);
     }
-    await loggedUser.save();
+    try { await loggedUser.save(); } catch (e) {
+      if (e.name === 'SequelizeUniqueConstraintError') return res.status(422).json({ errors: { body: ['Username already taken'] } });
+      throw e;
+    }
(also add a migration adding a unique index on Users.username, and dedupe existing rows first)
```

## `frontend/src/components/CommentEditor/CommentEditor.jsx` (4)

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

### S-165 [P2] Lose network while posting a comment

**What broke:** Failed comment post clears the typed text and shows no error

- Expected: An error says the comment was not posted, the typed text stays in the box for a retry, and no duplicate appears after the retry.
- Actual: The textarea is cleared immediately on click, before the request finishes. No error is shown to the user; the failure is only logged with console.error. The text can't be recovered.
- Root cause: frontend/src/components/CommentEditor/CommentEditor.jsx:20 has `.then(setForm({ body: "" }))`. This calls setForm immediately instead of passing a callback, so the form clears before the request resolves, even when it fails. Line 21 `.catch(console.error)` only logs the error and never shows it in the UI. The component has no error state.
- Screenshot: `.crashtest/shots/S-165/offline.png`

```diff
--- a/frontend/src/components/CommentEditor/CommentEditor.jsx
+++ b/frontend/src/components/CommentEditor/CommentEditor.jsx
@@
-  const [{ body }, setForm] = useState({ body: "" });
+  const [{ body }, setForm] = useState({ body: "" });
+  const [error, setError] = useState("");
+  const [posting, setPosting] = useState(false);
@@
-    if (body.trim() === "") return;
+    if (body.trim() === "" || posting) return;
+    setError("");
+    setPosting(true);
 
     postComment({ body, headers, slug })
-      .then(updateComments)
-      .then(setForm({ body: "" }))
-      .catch(console.error);
+      .then((res) => {
+        updateComments(res);
+        setForm({ body: "" });
+      })
+      .catch(() => setError("Comment was not posted. Please try again."))
+      .finally(() => setPosting(false));
   };
@@
+      {error && <div className="error-messages" role="alert">{error}</div>}
       <div className="card-block">
```

### S-167 [P2] Session expires while writing a comment

**What broke:** Comment draft is wiped and no sign-in prompt appears when the comment POST returns 401

- Expected: On 401 the user sees a prompt to sign in again, and the typed comment is preserved (or the user is redirected with the draft kept).
- Actual: The textarea is cleared immediately and the page shows nothing. The 401 only reaches console.error. The user is not redirected and not told the session expired.
- Root cause: frontend/src/components/CommentEditor/CommentEditor.jsx:18-21: `.then(setForm({ body: "" }))` calls setForm immediately, when the promise chain is built, rather than after success. The form is therefore cleared before the request finishes or fails. `.catch(console.error)` swallows the 401 that errorHandler.js:8 throws, so no UI feedback is shown and there is no redirect to /login.
- Screenshot: `.crashtest/shots/S-167/after.png`

```diff
--- a/frontend/src/components/CommentEditor/CommentEditor.jsx
+++ b/frontend/src/components/CommentEditor/CommentEditor.jsx
@@
-  const [{ body }, setForm] = useState({ body: "" });
+  const [{ body }, setForm] = useState({ body: "" });
+  const [error, setError] = useState("");
@@
     postComment({ body, headers, slug })
       .then(updateComments)
-      .then(setForm({ body: "" }))
-      .catch(console.error);
+      .then(() => setForm({ body: "" }))
+      .catch((err) => setError(String(err) || "Session expired. Please sign in again."));
@@
+      {error && (
+        <div className="error-messages">
+          {error} <Link to="/login">Sign in</Link>
+        </div>
+      )}
       <div className="card-footer">
```

## `backend/controllers/comments.js` (4)

### S-163 [P2] Post a comment with a request missing the comment object

**What broke:** Comment POST: missing comment object gives 500, non-string body is accepted (201)

- Expected: Both requests return 422 with errors.body and no comment is created
- Actual: {} returns 500 with a destructure error message. {comment:{body:123}} returns 201 and the comment is stored as '123'.
- Root cause: backend/controllers/comments.js:41 destructures req.body.comment without checking that it exists. Line 42 only checks that body is truthy, not that it is a string.

```diff
--- a/backend/controllers/comments.js
+++ b/backend/controllers/comments.js
@@ -41,2 +41,3 @@
-    const { body } = req.body.comment;
-    if (!body) throw new FieldRequiredError("Comment body");
+    const body = req.body?.comment?.body;
+    if (typeof body !== "string" || !body.trim())
+      throw new FieldRequiredError("Comment body");
```

### S-169 [P2] View an article with many comments

**What broke:** Comments list has no ORDER BY, so it is not returned newest-first

- Expected: Comments returned and displayed newest first (c200, c199, c198, …)
- Actual: Order is c198, c195, … c3, c199, c196, …: grouped by author, not chronological
- Root cause: backend/controllers/comments.js:19-23: article.getComments({include}) has no `order` option, so the DB returns rows in arbitrary order.
- Screenshot: `.crashtest/shots/S-169/comments.png`

```diff
--- a/backend/controllers/comments.js
+++ b/backend/controllers/comments.js
@@ -19,4 +19,5 @@
     const comments = await article.getComments({
+      order: [["createdAt", "DESC"], ["id", "DESC"]],
       include: [
         { model: User, as: "author", attributes: { exclude: ["email"] } },
```

### S-170 [P2] Delete a comment via a different article's slug

**What broke:** Comment can be deleted through another article's slug

- Expected: 404 because the comment does not belong to article Y
- Actual: 200 OK, and the comment on article X was deleted
- Root cause: backend/controllers/comments.js:70-79: deleteComment reads `slug` from req.params but never uses it. It looks the comment up with findByPk(commentId) and checks only the owner before calling destroy().

```diff
--- a/backend/controllers/comments.js
+++ b/backend/controllers/comments.js
@@ deleteComment
-    const comment = await Comment.findByPk(commentId);
-    if (!comment) throw new NotFoundError("Comment");
+    const article = await Article.findOne({ where: { slug } });
+    if (!article) throw new NotFoundError("Article");
+    const comment = await Comment.findOne({ where: { id: commentId, articleId: article.id } });
+    if (!comment) throw new NotFoundError("Comment");
```

### S-171 [P2] Delete a nonexistent comment id

**What broke:** DELETE comment with non-numeric id returns 500 instead of 404

- Expected: 404 for a non-numeric comment id
- Actual: 500 {"errors":{"body":["invalid input syntax for type integer: \"abc\""]}}, which also leaks the DB error text
- Root cause: backend/controllers/comments.js:72 passes the unvalidated commentId to Comment.findByPk. Postgres throws on the integer cast and the error handler turns it into a 500.

```diff
--- a/backend/controllers/comments.js
+++ b/backend/controllers/comments.js
@@ -70,3 +70,4 @@
     const { slug, commentId } = req.params;
+    if (!/^\d+$/.test(commentId)) throw new NotFoundError("Comment");
 
     const comment = await Comment.findByPk(commentId);
```

## `frontend/src/context/AuthContext.jsx` (3)

### S-059 [P2] Session with a corrupted localStorage value

**What broke:** Corrupted localStorage 'loggedUser' crashes the whole app to a blank screen

- Expected: The app treats the user as logged out and shows the public home feed.
- Actual: The page is blank. The module-level JSON.parse throws while the bundle loads, so React never mounts.
- Root cause: frontend/src/context/AuthContext.jsx:10 calls JSON.parse(localStorage.getItem("loggedUser")) at module scope with no try/catch. Invalid JSON throws on import and nothing renders.
- Screenshot: `.crashtest/shots/S-059/blank.png`

```diff
--- a/frontend/src/context/AuthContext.jsx
+++ b/frontend/src/context/AuthContext.jsx
@@ -7,3 +7,12 @@
   return useContext(AuthContext);
 }
 
-const loggedIn = JSON.parse(localStorage.getItem("loggedUser"));
+function readStoredUser() {
+  try {
+    return JSON.parse(localStorage.getItem("loggedUser"));
+  } catch {
+    localStorage.removeItem("loggedUser");
+    return null;
+  }
+}
+
+const loggedIn = readStoredUser();
```

### S-060 [P2] Session whose user was deleted on the server

**What broke:** Stale session is not cleared when GET /api/user returns 404/401; app stays in a logged-in state

- Expected: On a 401/404 from GET /api/user the app removes the stored session and shows the signed-out navbar (Sign in / Sign up).
- Actual: The server returned 404, but localStorage loggedUser stayed in place and the navbar still showed New Article and the deleted username ghost60.
- Root cause: frontend/src/context/AuthContext.jsx:32-34. The getUser() rejection is only passed to console.error, so the session is never reset. The initial state at lines 10-27 comes straight from localStorage with isAuth already true, and nothing revalidates it.
- Screenshot: `.crashtest/shots/S-060/after.png`

```diff
--- a/frontend/src/context/AuthContext.jsx
+++ b/frontend/src/context/AuthContext.jsx
@@
     getUser({ headers })
       .then((loggedUser) => setAuthState((prev) => ({ ...prev, loggedUser })))
-      .catch(console.error);
+      .catch((err) => {
+        console.error(err);
+        localStorage.removeItem("loggedUser");
+        setAuthState(authState);
+      });
```

### S-061 [P2] Session persists across two tabs and logout in one tab

**What broke:** Tab B stays authenticated after logout in tab A; its favorite action succeeds with 200

- Expected: Tab B's favorite fails with 401 or the app detects the cleared session. No action is performed as the logged-out user.
- Actual: Tab B still showed the signed-in navbar. Its favorite POST returned 200 and the count went 0→1. Only the reload afterwards showed the signed-out state.
- Root cause: The auth state is read from localStorage once at module load (frontend/src/context/AuthContext.jsx:10) and kept in React state with the token in headers. There is no `storage` event listener, so logout in another tab is never noticed. The backend JWT is stateless and has no revocation, so the old token is still accepted. userLogout.js:2 only removes the localStorage key.
- Screenshot: `.crashtest/shots/S-061/tabB-after-fav.png`

```diff
--- a/frontend/src/context/AuthContext.jsx
+++ b/frontend/src/context/AuthContext.jsx
@@ function AuthProvider({ children }) {
+  useEffect(() => {
+    const onStorage = (e) => {
+      if (e.key === "loggedUser" || e.key === null) {
+        setAuthState(e.newValue ? JSON.parse(e.newValue) : authState);
+      }
+    };
+    window.addEventListener("storage", onStorage);
+    return () => window.removeEventListener("storage", onStorage);
+  }, []);
+
   useEffect(() => {
     if (!headers) return;
```

## `frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx` (3)

### S-064 [P2] Sign in redirects back to the page the user came from

**What broke:** Logged-out visit to #/editor redirects to home (#/) instead of #/login

- Expected: Protected page #/editor redirects to #/login, and after sign-in the user lands on home or the editor.
- Actual: The URL became #/ (home feed). The visitor is never sent to the login form and gets no hint that sign-in is needed. Because the redirect carries no return location, the 'come back after sign-in' flow cannot work.
- Root cause: frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx:22-23 redirects unauthenticated users with navigate('/', {replace:true, state:null}). The route in frontend/src/main.jsx:37 has no auth guard that sends users to /login. LoginForm.jsx also does not read a 'from' location.
- Screenshot: `.crashtest/shots/S-064/redirect.png`

```diff
--- a/frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx
+++ b/frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx
@@ -19,7 +19,8 @@
   useEffect(() => {
     const redirect = () => navigate("/", { replace: true, state: null });
-    if (!isAuth) return redirect();
+    if (!isAuth)
+      return navigate("/login", { replace: true, state: { from: "/editor" } });
 
     // (LoginForm should then navigate(location.state?.from || "/") after a successful sign-in)
```

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

## `frontend/src/routes/Article/Article.jsx` (3)

### S-094 [P2] Lose the network while the article loads

**What broke:** Article page shows empty skeleton with 'Invalid Date' when offline; no loading or error state

- Expected: A loading or error message is shown while the article can't be fetched.
- Actual: Blank banner and body, with 'Invalid Date' and 'Followers ( )' placeholders. There is no loading indicator and no error message.
- Root cause: frontend/src/routes/Article/Article.jsx:13 initialises article as {} and renders the full layout with no loading or error state. getArticle.js:9-11 passes the error to errorHandler and returns undefined. On a network error, the catch at Article.jsx:24 may not navigate to /not-found, because errorHandler may not rethrow. Nothing is shown to the user either way.
- Screenshot: `.crashtest/shots/S-094/offline.png`

```diff
--- a/frontend/src/routes/Article/Article.jsx
+++ b/frontend/src/routes/Article/Article.jsx
@@
+  const [loadError, setLoadError] = useState(false);
@@
-    getArticle({ slug, headers })
-      .then(setArticle)
+    setLoadError(false);
+    getArticle({ slug, headers })
+      .then((a) => (a ? setArticle(a) : setLoadError(true)))
       .catch((error) => {
@@
+  if (loadError) return <p role="alert">Could not load article. Check your connection and reload.</p>;
+  if (!state && !title) return <p>Loading article...</p>;
   return (
```

### S-095 [P2] Article page loads while the backend is down

**What broke:** Article page shows misleading '404 Not Found' when backend is unreachable

- Expected: A clear error or retry message saying the server can't be reached.
- Actual: Any fetch failure, including a network error, redirects to #/not-found, which says '404 Not Found'. This wrongly tells the user the article doesn't exist. There is no retry.
- Root cause: frontend/src/routes/Article/Article.jsx:24-27: the catch handler navigates to /not-found for every error. It doesn't check whether the failure was a network error or a real 404. NotFound.jsx has only a static 404 message.
- Screenshot: `.crashtest/shots/S-095/final.png`

```diff
--- a/frontend/src/routes/Article/Article.jsx
+++ b/frontend/src/routes/Article/Article.jsx
@@
-  const [article, setArticle] = useState(state || {});
+  const [article, setArticle] = useState(state || {});
+  const [loadError, setLoadError] = useState(null);
@@
       .catch((error) => {
         console.error(error);
-        navigate("/not-found", { replace: true });
+        if (error?.response?.status === 404) {
+          navigate("/not-found", { replace: true });
+        } else {
+          setLoadError("Could not reach the server. Please try again.");
+        }
       });
@@
   return (
     <div className="article-page">
+      {loadError && (
+        <div className="container" role="alert">
+          {loadError} <button onClick={() => window.location.reload()}>Retry</button>
+        </div>
+      )}
```

### S-102 [P3] Show a long article body without breaking the layout

**What broke:** Long unbroken URL and wide code block overflow the article page horizontally at 480px

- Expected: Long text wraps or code blocks scroll inside their own box, and the page does not scroll sideways past the viewport.
- Actual: At 480px the page scrollWidth is 5834px, so the whole page scrolls sideways. The long link overflows to x=5290 and the code block to x=5834.
- Root cause: The markdown body is rendered by markdown-to-jsx in frontend/src/routes/Article/Article.jsx:42 inside `.article-content .col-md-12`. frontend/src/styles.css:1330-1337 and 1347-1352 style the container and paragraphs, but no rule sets `overflow-wrap`/`word-break` on the body. There is also no `overflow-x:auto` rule for `pre`/`code` inside `.article-content`, so long unbroken content grows past the viewport.
- Screenshot: `.crashtest/shots/S-102/top2.png`

```diff
--- a/frontend/src/styles.css
+++ b/frontend/src/styles.css
@@ -1346,3 +1346,15 @@
 
+.article-page .article-content .col-md-12 {
+  min-width: 0;
+  overflow-wrap: anywhere;
+}
+
+.article-page .article-content pre {
+  max-width: 100%;
+  overflow-x: auto;
+}
+
+.article-page .article-content pre code {
+  white-space: pre;
+}
+
 .article-page .article-content p {
```

## `backend/middleware/errorHandler.js` (3)

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

### S-130 [P2] Publish with a very long title and body

**What broke:** Oversized article payload returns 500 instead of 413

- Expected: Article is saved, or the server returns a clear 413/422 error; never a 500.
- Actual: POST /api/articles returned 500 {"errors":{"body":["request entity too large"]}}. The article was not saved and the editor stayed open.
- Root cause: backend/middleware/errorHandler.js:26-28 sends every error that isn't a custom one as 500. body-parser's 'request entity too large' error carries status/statusCode 413 (express.json() default limit is 100kb, backend/index.js:17), so it falls into that branch. The 100 KB body plus the JSON overhead goes over the limit.
- Screenshot: `.crashtest/shots/S-130/result.png`

```diff
--- a/backend/middleware/errorHandler.js
+++ b/backend/middleware/errorHandler.js
@@ -24,6 +24,9 @@
   } else if (error instanceof ValidationError) {
     console.log(error);
     res.status(422).json({ errors: { body: [error.message] } });
+  } else if (error.status === 413 || error.type === 'entity.too.large') {
+    console.log(error);
+    res.status(413).json({ errors: { body: [error.message] } });
   } else {
     console.log(error);
     res.status(500).json({ errors: { body: [error.message] } });
```

### S-281 [P2] Handle a very long title and body on article create

**What broke:** Oversized title/body on article create returns 500 instead of 422/413

- Expected: 422 for the too-long title, 413 for the 5 MB body, each with a clear error body
- Actual: Both requests returned 500. The title error leaked the DB message 'value too long for type character varying(255)'. The body error was 'request entity too large'.
- Root cause: backend/middleware/errorHandler.js:26-28 sends every error that is not a custom error as 500. body-parser's PayloadTooLargeError carries status 413 and Sequelize's DatabaseError for an over-length column is a validation-type error, but neither is mapped. Article create also has no title length validation before the insert.

```diff
--- a/backend/middleware/errorHandler.js
+++ b/backend/middleware/errorHandler.js
@@
+  } else if (error.status === 413 || error.type === "entity.too.large") {
+    res.status(413).json({ errors: { body: ["Request body too large"] } });
+  } else if (error.name === "SequelizeDatabaseError" && /too long/.test(error.message)) {
+    res.status(422).json({ errors: { body: ["A field exceeds the maximum length"] } });
   } else {
```

## `frontend/src/services/userLogout.js` (3)

### S-174 [P2] Author comment after logging out in another tab

**What broke:** Logging out in another tab doesn't invalidate tab A's session; a stale-session comment is posted under the old identity

- Expected: The Post request is rejected with 401 and the user is asked to sign in. No comment is posted.
- Actual: The comment was created (id 732) under the logged-out user's identity. Tab A still looked signed in and showed no 401 or sign-in prompt.
- Root cause: Logout is client-side only. frontend/src/services/userLogout.js:2 just removes localStorage 'loggedUser'. There is no server-side revocation, and the JWT is stateless, so the old token stays valid. frontend/src/context/AuthContext.jsx:21-35 keeps `headers` (with the token) in React state and has no 'storage' event listener, so tab A never learns about the logout. Tab A therefore keeps sending the old Authorization header and the backend accepts it.
- Screenshot: `.crashtest/shots/S-174/result.png`

```diff
--- a/frontend/src/context/AuthContext.jsx
+++ b/frontend/src/context/AuthContext.jsx
@@ function AuthProvider({ children }) {
+  useEffect(() => {
+    const onStorage = (e) => {
+      if (e.key === "loggedUser" && !e.newValue) {
+        setAuthState(authState);
+        window.location.hash = "#/login";
+      }
+    };
+    window.addEventListener("storage", onStorage);
+    return () => window.removeEventListener("storage", onStorage);
+  }, []);
+
   useEffect(() => {
     if (!headers) return;

For a true 401, the backend also needs server-side token revocation (e.g. a token blocklist or tokenVersion checked in the auth middleware, bumped on logout). Without it, the old token still authenticates.
```

### S-210 [P2] Favorite button state after the user's session is revoked in another tab

**What broke:** Logout in one tab does not invalidate the session in another tab; Favorite still succeeds after logout

- Expected: Tab A gets 401 and prompts sign-in, and no favorite is recorded for the logged-out state.
- Actual: Tab A kept its in-memory auth state. Favorite returned 200 and was recorded, the count went to 1, the button turned active, and there was no sign-in prompt.
- Root cause: Logout only calls localStorage.removeItem and resets the logging-out tab's React state (frontend/src/services/userLogout.js:2). The JWT is stateless and is never revoked server-side. Other tabs keep the token in AuthContext state (frontend/src/context/AuthContext.jsx:25) and never listen for the `storage` event. FavButton only checks the in-memory isAuth (frontend/src/components/FavButton/FavButton.jsx:14), so it sends the old token and the API accepts it.
- Screenshot: `.crashtest/shots/S-210/tabA-after.png`

```diff
--- a/frontend/src/context/AuthContext.jsx
+++ b/frontend/src/context/AuthContext.jsx
@@ inside AuthProvider, after the useState call
+  useEffect(() => {
+    const onStorage = (e) => {
+      if (e.key === "loggedUser" && !e.newValue) setAuthState(userLogout);
+    };
+    window.addEventListener("storage", onStorage);
+    return () => window.removeEventListener("storage", onStorage);
+  }, []);

(import userLogout from "../services/userLogout" in AuthContext.jsx. Server-side token revocation would be needed for a true 401 on other clients.)
```

### S-250 [P2] Logged-out tab cannot save settings after logout in another tab

**What broke:** Logout in one tab does not invalidate the session; the other tab can still save settings

- Expected: Tab B's PUT /api/user is rejected with 401, the user sees a sign-in prompt, and the bio is not saved
- Actual: Tab B still holds the JWT in memory and the server accepts it (stateless JWT, no revocation). The update succeeds and is saved. The expected 401 and sign-in prompt would not appear.
- Root cause: frontend/src/services/userLogout.js:2 only calls localStorage.removeItem, and there is no cross-tab 'storage' listener in frontend/src/context/AuthContext.jsx:24-42. backend/helper/jwt.js:12 only does jwt.verify, with no server-side session or blacklist. userUpdate.js:20-21 sends the stale headers and has no 401 handling.

```diff
--- a/frontend/src/context/AuthContext.jsx
+++ b/frontend/src/context/AuthContext.jsx
@@ function AuthProvider({ children }) {
+  useEffect(() => {
+    const onStorage = (e) => {
+      if (e.key === "loggedUser" && !e.newValue) setAuthState(authState);
+    };
+    window.addEventListener("storage", onStorage);
+    return () => window.removeEventListener("storage", onStorage);
+  }, []);

This fix clears tab B's auth state and redirects it to sign-in, but the client never sends a 401. Rejecting the request with a 401, as the scenario expects, needs server-side token revocation (e.g. a token blacklist on logout).
```

## `frontend/src/helpers/errorHandler.js` (2)

### S-062 [P2] Sign in while the backend is down

**What broke:** Login with backend down crashes the whole app to a blank white page instead of showing an error

- Expected: The form shows a network or server error message, the button re-enables, there is no infinite spinner, and no session is stored.
- Actual: The proxy's 500 has no JSON body. errorHandler throws a TypeError (an Error object), which Login stores as state and renders as a React child. React throws, and with no error boundary the entire page unmounts to blank white.
- Root cause: frontend/src/helpers/errorHandler.js:6-8. For a 500 from the proxy, `data.errors` is undefined, so `data.errors.body[0]` throws a TypeError. That Error object propagates through the .catch(onError) at LoginForm.jsx:18 into setErrorMessage in routes/Login.jsx:9. AuthPageContainer.jsx:16 renders it as `<li>{error}</li>`, which crashes React. Separately, the `!error.response` branch (line 2) swallows genuine network errors, so the user would see nothing.
- Screenshot: `.crashtest/shots/S-062/after-submit.png`

```diff
--- a/frontend/src/helpers/errorHandler.js
+++ b/frontend/src/helpers/errorHandler.js
@@
 function errorHandler(error) {
-  if (!error.response) return console.log(error);
+  if (!error.response) throw "Network error: unable to reach the server. Please try again.";
 
   const { status, data } = error.response;
 
-  if ([401, 403, 404, 422, 500].includes(status)) {
-    console.log(error.response, data.errors.body[0]);
-    throw data.errors.body[0];
+  if ([401, 403, 404, 422, 500].includes(status)) {
+    throw data?.errors?.body?.[0] ?? `Server error (${status}). Please try again later.`;
   }
 
-  console.dir(error);
+  throw `Unexpected error (${status}).`;
 }
```

### S-063 [P2] Lose the network during sign up

**What broke:** Network failure during sign up crashes the whole app (blank page) instead of showing an error

- Expected: The first attempt shows an error message and the form stays usable, so a retry can create the account once.
- Actual: With the network offline, submitting the form unmounts the whole React tree. The user sees a blank page, with no error message and no form to retry from.
- Root cause: frontend/src/helpers/errorHandler.js:2 returns silently when `error.response` is missing, which is the case for a network error. userSignUp.js:20-22 then resolves with undefined. SignUpForm.jsx:20 does `.then(setAuthState)`, so auth state becomes undefined. AuthContext.jsx:25 then destructures undefined and throws. LoginForm.jsx:16 uses the same pattern, so login is affected too.

```diff
--- a/frontend/src/helpers/errorHandler.js
+++ b/frontend/src/helpers/errorHandler.js
@@
-  if (!error.response) return console.log(error);
+  if (!error.response) throw "Network error. Please check your connection and try again.";

```

## `frontend/src/services/setArticle.js` (2)

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

### S-134 [P2] Two tabs editing the same article

**What broke:** Concurrent editor saves silently overwrite each other: tab B's save reverts tab A's description and drops tags

- Expected: Both edits are kept, or tab B's save is rejected with a clear conflict message. The stored article should be one coherent version with no unrelated fields silently reverted.
- Actual: Both saves returned success. The stored article has description 'd0' (A's edit lost), body 'body from B', and tagList [] (originally ['x']). Neither tab showed a warning.
- Root cause: The editor form loads the article once and sends every field (title, description, body, tagList) on save (frontend/src/services/setArticle.js:4-17, ArticleEditorForm.jsx:54). Tab B's form still held the stale description 'd0', so its save overwrote A's change. The backend updateArticle (backend/controllers/articles.js:175-208) applies the fields blindly. It has no version or updatedAt precondition (If-Match or equivalent), so it cannot detect a stale write. I did not trace why the tag was dropped. The editor's tag input was empty on load, and the backend update handler does not use tagList.
- Screenshot: `.crashtest/shots/S-134/after-b.png`

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@ updateArticle
-    const { title, description, body } = req.body.article;
+    const { title, description, body, updatedAt } = req.body.article;
+    if (updatedAt && new Date(updatedAt).getTime() !== new Date(article.updatedAt).getTime()) {
+      return res.status(409).json({ errors: { body: ["Article was modified elsewhere. Reload and retry."] } });
+    }
--- a/frontend/src/services/setArticle.js
+++ b/frontend/src/services/setArticle.js
-async function setArticle({ body, description, headers, slug, tagList, title }) {
+async function setArticle({ body, description, headers, slug, tagList, title, updatedAt }) {
-      data: { article: { title, description, body, tagList } },
+      data: { article: { title, description, body, tagList, updatedAt } },
(Also add 409 to the status list in frontend/src/helpers/errorHandler.js, and pass the loaded article's updatedAt from ArticleEditorForm.)
```

## `frontend/src/services/getArticles.js` (2)

### S-142 [P2] Publish a large batch of articles and paginate the author's list

**What broke:** Profile article list paginates 3 per page (20 pages for 60 articles) instead of 20-article slices

- Expected: Three pages of 20 articles each, newest first, total 60
- Actual: The profile list shows 3 articles per page and the paginator shows 20 pages. The page size is hard-coded to 3.
- Root cause: frontend/src/services/getArticles.js:5 defaults limit = 3. frontend/src/components/ArticlesPagination/ArticlesPagination.jsx:12 hard-codes Math.ceil(articlesCount / 3). backend/controllers/articles.js:26 also defaults limit to 3. The backend treats offset as a page index (offset * limit at line 43), not a record offset.

```diff
--- a/frontend/src/services/getArticles.js
+++ b/frontend/src/services/getArticles.js
@@
-async function getArticles({ headers, limit = 3, location, page = 0, tagName, username }) {
+async function getArticles({ headers, limit = 20, location, page = 0, tagName, username }) {
--- a/frontend/src/components/ArticlesPagination/ArticlesPagination.jsx
+++ b/frontend/src/components/ArticlesPagination/ArticlesPagination.jsx
@@
-  const totalPages = Math.ceil(articlesCount / 3);
+  const totalPages = Math.ceil(articlesCount / 20);

The backend default limit at articles.js:26 and :127 should also change to 20.
```

### S-262 [P3] Log out button is usable with a slow or failed logout call

**What broke:** Logging out while the API is unreachable crashes the home feed and blanks the whole app

- Expected: The local session is cleared and the signed-out nav (Home / Login / Sign up) is shown, with no spinner and no crash.
- Actual: The session is cleared, but the React tree unmounts. The page is completely blank (no nav, no content) until it is reloaded. Screenshot: .crashtest/shots/S-262/after-logout.png
- Root cause: frontend/src/services/getArticles.js:18-20 catches a network error and returns undefined, because errorHandler does not rethrow. frontend/src/hooks/useArticles.js:18-19 passes that result to setArticlesData, so state becomes undefined. The destructuring `const [{ articles, articlesCount }, ...] = useState(...)` at useArticles.js:6 then throws on the next render. Logout changes `headers`, which re-runs the effect at useArticles.js:13-22. With no error boundary, the whole app unmounts.
- Screenshot: `.crashtest/shots/S-262/after-logout.png`

```diff
--- a/frontend/src/hooks/useArticles.js
+++ b/frontend/src/hooks/useArticles.js
@@ -18,3 +18,3 @@
     getArticles({ headers, location, tabName, tagName, username })
-      .then(setArticlesData)
+      .then((data) => data && setArticlesData(data))
       .catch(console.error)
```

## `frontend/src/components/CommentList/CommentList.jsx` (2)

### S-162 [P2] Post a very long comment

**What broke:** Very long unbroken comment does not wrap and blows out page width (horizontal overflow ~86,000px)

- Expected: Saved comment wraps inside the comment card without breaking the layout, or a validation error is shown
- Actual: Comment saved (10,000 chars) but rendered on one line. Document scrollWidth is 85997 vs clientWidth 1280. See .crashtest/shots/S-162/after-reload.png and final.png.
- Root cause: frontend/src/components/CommentList/CommentList.jsx:34 renders `<p className="card-text">{body}</p>` and the .card-text styles in frontend/src/styles.css (around line 931) have no overflow-wrap or word-break rule. The backend also has no comment length limit.

```diff
--- a/frontend/src/styles.css
+++ b/frontend/src/styles.css
@@
+.card-text {
+  overflow-wrap: anywhere;
+  word-break: break-word;
+}
```

### S-172 [P2] Delete the same comment twice from two tabs

**What broke:** Second delete of an already-deleted comment returns 404 but tab B keeps showing the stale comment

- Expected: Tab B handles the 404 gracefully and the comment disappears from the list, with no crash
- Actual: Tab B logged console errors (404 on DELETE comments/729, 'Comment not found'). The comment stayed visible and no message was shown. The list only refreshes on a successful delete.
- Root cause: frontend/src/components/CommentList/CommentList.jsx:24-26: deleteComment(...).then(updateComments).catch(console.error). On a 404 the promise rejects, so updateComments (the refetch trigger) never runs and the error is only logged.
- Screenshot: `.crashtest/shots/S-172/tabB.png`

```diff
--- a/frontend/src/components/CommentList/CommentList.jsx
+++ b/frontend/src/components/CommentList/CommentList.jsx
@@ -24,3 +24,6 @@
     deleteComment({ commentId, headers, slug })
       .then(updateComments)
-      .catch(console.error);
+      .catch((err) => {
+        console.error(err);
+        updateComments(); // comment may already be deleted elsewhere; resync list
+      });
```

## `backend/index.js` (2)

### S-175 [P2] Comment textarea accepts a very long string at the API boundary

**What broke:** Oversized request body (1MB comment) returns 500 instead of 413/422

- Expected: 413 or 422 for an oversized body, or acceptance within a documented limit
- Actual: HTTP 500 {"errors":{"body":["request entity too large"]}}. The server survived.
- Root cause: express.json() (backend/index.js:17) throws a body-parser error with status 413. The catch-all in backend/middleware/errorHandler.js:28 sends 500 for anything it doesn't recognise, and it ignores err.status/err.type. There is also no explicit per-field length limit on comment body.

```diff
--- a/backend/middleware/errorHandler.js
+++ b/backend/middleware/errorHandler.js
@@ -25,3 +25,6 @@
     res.status(422).json({ errors: { body: [error.message] } });
+  } else if (error.type === 'entity.too.large' || error.status === 413) {
+    res.status(413).json({ errors: { body: [error.message] } });
   } else {
     res.status(500).json({ errors: { body: [error.message] } });
```

### S-285 [P2] Reseed the database and keep existing tables intact on restart

**What broke:** sync({alter:true}) fails on restart with FK violation from orphan Articles rows; the server keeps running without a finished schema sync

- Expected: Server starts without errors, existing rows are kept, and schema changes are applied without dropping data.
- Actual: On every restart, sync aborts with SequelizeForeignKeyConstraintError ('Articles_userId_fkey', Key (userId)=(167) is not present in table "Users"). The error is logged as 'Unable to connect to the database'. Data survives (606 articles, 409 tags unchanged) and the API responds 200, but the schema is not altered.
- Root cause: backend/index.js:21 runs sequelize.sync({ alter: true }). The alter step re-adds the Articles.userId foreign key with ON DELETE SET NULL, and it fails because Articles already contains rows whose userId (167) has no matching Users row. The catch block at index.js:23-24 only logs the error, so the server keeps serving requests with a partly-synced schema and the message misleadingly says 'Unable to connect'.

```diff
--- a/backend/index.js
+++ b/backend/index.js
@@
 (async () => {
   try {
+    // clean orphaned rows so alter can re-add the FK
+    await sequelize.query('UPDATE "Articles" SET "userId" = NULL WHERE "userId" IS NOT NULL AND "userId" NOT IN (SELECT id FROM "Users")').catch(() => {});
     await sequelize.sync({ alter: true });
     console.log(`Connection with ${env} database has been established.`);
   } catch (error) {
-    console.error("Unable to connect to the database:", error);
+    console.error("Database sync failed:", error);
+    process.exit(1);
   }
 })();
```

## `backend/controllers/profiles.js` (2)

### S-193 [P1] Following yourself is refused

**What broke:** A user can follow themselves via POST /api/profiles/:username/follow

- Expected: A 4xx rejection, and no self-follow row. The follower count stays at 0.
- Actual: 200 OK. The profile shows following:true and followersCount:1 for the user's own profile.
- Root cause: backend/controllers/profiles.js:39-40. followToggler calls profile.addFollower(loggedUser) without checking that loggedUser is not the target profile.

```diff
--- a/backend/controllers/profiles.js
+++ b/backend/controllers/profiles.js
@@ -37,3 +37,6 @@
     if (!profile) throw new NotFoundError("User profile");
 
+    if (req.method === "POST" && profile.id === loggedUser.id) {
+      return res.status(422).json({ errors: { body: ["You cannot follow yourself"] } });
+    }
+
     if (req.method === "POST") {
```

### S-223 [P2] Following yourself is refused

**What broke:** API allows a user to follow themselves

- Expected: A 4xx rejection, or an ignored request, with no self-follow created
- Actual: 200 OK with following:true for alice on her own profile. The self-follow persisted: GET /api/profiles/alice also returns following:true.
- Root cause: backend/controllers/profiles.js:39-40. followToggler calls profile.addFollower(loggedUser) without checking that loggedUser is not the target profile.
- Screenshot: `.crashtest/shots/S-223/profile.png`

```diff
--- a/backend/controllers/profiles.js
+++ b/backend/controllers/profiles.js
@@ -36,6 +36,9 @@
     if (!profile) throw new NotFoundError("User profile");
 
+    if (profile.username === loggedUser.username) {
+      return res.status(422).json({ errors: { body: ["You cannot follow yourself"] } });
+    }
+
     if (req.method === "POST") {
```

## `frontend/src/components/PopularTags/TagButton.jsx` (1)

### S-027 [P3] Popular Tags sidebar with a very large number of tags

**What broke:** Popular Tags sidebar silently truncates to the first 50 tags and is not scrollable or contained

- Expected: Sidebar renders the full tag list from the API (or a scrollable or paginated view) and stays within its layout.
- Actual: The API returns 405 tags but the sidebar renders only 50, in an unsorted, non-popularity order. The sidebar is also a very tall column (~1600px) that stretches the page. The home page also showed overlapping tag chips in the article feed.
- Root cause: frontend/src/components/PopularTags/TagButton.jsx:10 hard-codes tagsList.slice(0, 50). The sidebar container has no max-height or overflow, so it can't scroll.
- Screenshot: `.crashtest/shots/S-027/full.png`

```diff
--- a/frontend/src/components/PopularTags/TagButton.jsx
+++ b/frontend/src/components/PopularTags/TagButton.jsx
-  return tagsList.slice(0, 50).map((name) => (
+  return tagsList.map((name) => (

(and wrap the tag list in PopularTags.jsx with a container styled `max-height: 70vh; overflow-y: auto;`)
```

## `frontend/src/index.css` (1)

### S-030 [P3] Browse the home page on a mobile-width viewport

**What broke:** Home pagination overflows off the left edge at 375px; first pages unreachable

- Expected: Pagination stays fully visible and usable, wrapping or scrolling within the viewport.
- Actual: With 151 pages, the .pagination ul (display:flex, nowrap, justify-content:center) is only 187px wide. Its prev-arrow and pages 1 and 2 sit at negative x (-79 to 19) and are clipped off-screen. They can't be scrolled to because the overflow is on the left.
- Root cause: frontend/src/index.css:1-4 sets .pagination to flex with justify-content:center and no flex-wrap. Centered overflow runs off the left edge, where it can't be scrolled to. The container is ArticlesPagination.jsx:27, class 'pagination pagination-sm'.
- Screenshot: `.crashtest/shots/S-030/pagination.png`

```diff
--- a/frontend/src/index.css
+++ b/frontend/src/index.css
@@ -1,4 +1,5 @@
 .pagination {
   display: flex;
+  flex-wrap: wrap;
   justify-content: center;
 }
```

## `backend/config/config.js` (1)

### S-065 [P2] Sign up with a password the same as the email or username

**What broke:** No password policy on signup (only non-empty check); signup also 500s from DB logging config and the UI crashes on the error

- Expected: A minimum password policy with a clear message (e.g. at least 8 characters, not equal to email); otherwise the account is created without leaking the password.
- Actual: POST /api/users returned 500 and the register page crashed with a React 'Objects are not valid as a React child' error. By code inspection, passwords like '1' or equal to the email would be accepted, since only !password is checked.
- Root cause: backend/config/config.js:9,17,25 pass process.env.*_DB_LOGGING (a string) as Sequelize `logging`, which must be a function or false. This causes 'options.logging is not a function' on every query and a 500 on signup. backend/controllers/users.js:17 only checks that the password is non-empty, with no length or email-equality validation. The frontend renders the Error object as a React child on failure.
- Screenshot: `.crashtest/shots/S-065/a.png`

```diff
--- a/backend/config/config.js
+++ b/backend/config/config.js
-    logging: process.env.DEV_DB_LOGGING,
+    logging: process.env.DEV_DB_LOGGING === 'true' ? console.log : false,
--- a/backend/controllers/users.js
+++ b/backend/controllers/users.js
     if (!password) throw new FieldRequiredError(`A password`);
+    if (password.length < 8) throw new ValidationError("Password must be at least 8 characters");
+    if (password === email || password === username) throw new ValidationError("Password must not match your email or username");
```

## `frontend/src/services/deleteComment.js` (1)

### S-093 [P2] Two tabs: delete a comment in one tab while the other still shows it

**What broke:** Deleting an already-deleted comment from a stale tab gives no UI feedback; the ghost comment stays visible

- Expected: Tab 2 shows an error, or the stale comment disappears (list refreshes), without crashing
- Actual: Server returned 404, as it should. Tab 2 still shows the deleted comment. There is no error message, and the list is not refetched. Only the console logs 'Comment not found'. Screenshot: .crashtest/shots/S-093/tab2.png
- Root cause: frontend/src/services/deleteComment.js:13-15 catches the error and only calls errorHandler, so the promise resolves as undefined. In frontend/src/components/CommentList/CommentList.jsx:24-26, .then(updateComments) is therefore skipped on 404 and .catch(console.error) never fires. Nothing refreshes the list or tells the user.
- Screenshot: `.crashtest/shots/S-093/tab2.png`

```diff
--- a/frontend/src/components/CommentList/CommentList.jsx
+++ b/frontend/src/components/CommentList/CommentList.jsx
@@ -24,3 +24,7 @@
     deleteComment({ commentId, headers, slug })
       .then(updateComments)
-      .catch(console.error);
+      .catch((err) => {
+        console.error(err);
+        updateComments(); // refetch so a stale comment disappears
+      });
--- a/frontend/src/services/deleteComment.js
+++ b/frontend/src/services/deleteComment.js
@@ -13,3 +13,4 @@
   } catch (error) {
     errorHandler(error);
+    throw error;
   }
```

## `backend/helper/helpers.js` (1)

### S-109 [P3] Article page with a missing or deleted author account

**What broke:** Article endpoint returns 500 when the article's author user no longer exists

- Expected: Page renders without a crash, shows a fallback author name or hides the article, and the API does not return 500.
- Actual: GET /api/articles/:slug returns 500 {"errors":{"body":["toAppend.hasFollower is not a function"]}}. The SPA lands on #/not-found.
- Root cause: backend/helper/helpers.js:22 only handles the article case when toAppend.author is truthy. With a missing author the code falls into the else branch (lines ~32-37), which is meant for User objects. It calls toAppend.hasFollower/countFollowers on the Article, which throws. singleArticle in controllers/articles.js:166 calls appendFollowers without a guard.
- Screenshot: `.crashtest/shots/S-109/final.png`

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@ singleArticle
     if (!article) throw new NotFoundError("Article");
+    if (!article.author) throw new NotFoundError("Article"); // orphaned article: hide it
 
     appendTagList(article.tagList, article);

The same guard belongs in the list endpoints, or the Articles→Users foreign key should be non-null with ON DELETE CASCADE so orphans cannot exist.
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

## `frontend/src/components/ArticleAuthorButtons/ArticleAuthorButtons.jsx` (1)

### S-139 [P2] Delete an article twice from two tabs

**What broke:** Second delete of an already-deleted article gives no visible 'not found' message; the error only goes to the console

- Expected: Second delete returns 404 and the UI shows a clear 'not found' message without crashing
- Actual: The DELETE returned 404, but tab B stayed unchanged on the stale article with Delete and Edit buttons still shown. No message appeared. The error was only logged to the console as 'Article not found'.
- Root cause: frontend/src/components/ArticleAuthorButtons/ArticleAuthorButtons.jsx:15-17 catches the rejected delete with `.catch(console.error)`, so the user never sees the error. frontend/src/services/deleteArticle.js:13-15 passes the error to errorHandler and then returns undefined. It's likely errorHandler doesn't throw in this case, which would also route the 404 into the `.then(() => navigate('/'))` path. In this run no redirect happened.
- Screenshot: `.crashtest/shots/S-139/tabB.png`

```diff
--- a/frontend/src/components/ArticleAuthorButtons/ArticleAuthorButtons.jsx
+++ b/frontend/src/components/ArticleAuthorButtons/ArticleAuthorButtons.jsx
@@
-    deleteArticle({ headers, slug })
-      .then(() => navigate("/"))
-      .catch(console.error);
+    deleteArticle({ headers, slug })
+      .then(() => navigate("/"))
+      .catch((error) => {
+        console.error(error);
+        alert(
+          error?.response?.status === 404 || /not found/i.test(error?.message || "")
+            ? "This article was not found. It may already have been deleted."
+            : "Could not delete the article."
+        );
+        navigate("/");
+      });
```

## `Root cause not located` (1)

### S-144 [P2] Publish from a session where the author's account was deleted

**What broke:** Valid JWT for a deleted user is rejected with 404 instead of 401/403

- Expected: Request refused with 401 or 403 and no orphan article
- Actual: HTTP 404 'User not found'. No article row was created (checked in the DB).
- Root cause: backend/middleware/auth.js, the `if (!req.loggedUser) next(new NotFoundError("User"))` check. It maps a missing user to a 404 NotFoundError instead of an auth failure. It also doesn't return after calling next(), so execution continues to `req.loggedUser.dataValues.token`, which throws a TypeError and calls next() a second time.

```diff
--- a/backend/middleware/auth.js
+++ b/backend/middleware/auth.js
@@
-    if (!req.loggedUser) next(new NotFoundError("User"));
+    if (!req.loggedUser) {
+      return res.status(401).json({ errors: { body: ["User no longer exists"] } });
+    }

```

## `backend/helper/customErrors.js` (1)

### S-145 [P2] Publish article offline-then-online returns duplicate protection

**What broke:** Duplicate-title 422 gives no way to open the existing article

- Expected: Second attempt returns 422 and the user is told the article already exists and can open it (link or slug of the existing article).
- Actual: 422 with the generic message 'Title already exists.. ' (note the stray '..'). There is no slug or link to the existing article, and the UI shows only the string.
- Root cause: backend/controllers/articles.js:~84-85 throws AlreadyTakenError('Title') without including the existing article's slug. backend/helper/customErrors.js:32-36 builds the message as '<prop> already exists.. <message>', so the text is generic. frontend/src/helpers/errorHandler.js:6-8 throws only data.errors.body[0], so the UI cannot show an 'open it' link.

```diff
--- a/backend/controllers/articles.js
+++ b/backend/controllers/articles.js
@@
-    if (slugInDB) throw new AlreadyTakenError("Title");
+    if (slugInDB) throw new AlreadyTakenError("Title", `Open it at #/article/${slug}`);

The frontend would also need to render the slug as a link in the error list.
```

## `frontend/src/services/getComments.js` (1)

### S-178 [P3] Show correct following and author state on comments when signed in

**What broke:** Comment list fetched without auth token, so followed authors show as not following

- Expected: The followed author (s178b) shows as following, for example an Unfollow button on the profile reached from the comment. The non-followed author (s178c) shows as not following.
- Actual: The comment author links carry following:false for every author. The profile opened from s178b's comment shows 'Follow s178b', even though the API with a token returns following:true.
- Root cause: frontend/src/services/getComments.js:6 calls axios without the auth headers. CommentList.jsx:13 calls getComments({ slug }) and never passes `headers`, so the backend sees an anonymous request and returns following:false. CommentAuthor.jsx:9 and :16 pass that value to the profile page through Link state, and AuthorInfo.jsx:19 then skips refetching.
- Screenshot: `.crashtest/shots/S-178/comments.png`

```diff
--- a/frontend/src/services/getComments.js
+++ b/frontend/src/services/getComments.js
@@
-async function getComments({ slug }) {
+async function getComments({ slug, headers }) {
   try {
-    const { data } = await axios({ url: `api/articles/${slug}/comments` });
+    const { data } = await axios({ url: `api/articles/${slug}/comments`, headers });
--- a/frontend/src/components/CommentList/CommentList.jsx
+++ b/frontend/src/components/CommentList/CommentList.jsx
@@
-    getComments({ slug }).then(setComments).catch(console.error);
-  }, [slug, triggerUpdate]);
+    getComments({ slug, headers }).then(setComments).catch(console.error);
+  }, [slug, triggerUpdate, headers]);
```

## `frontend/src/helpers/dateFormatter.js` (1)

### S-181 [P3] Comment timestamp shown in the viewer's time zone

**What broke:** Comment timestamp shows only a date, no local time or relative 'just now'

- Expected: A recent comment shows a local time or relative time such as 'just now' or '2 minutes ago'.
- Actual: Only a calendar date is shown, e.g. 'October 10, 2026'. A user cannot tell how recent the comment is, and the viewer's time zone is not visible.
- Root cause: frontend/src/helpers/dateFormatter.js:2-6 formats with toLocaleDateString and month/day/year only. CommentList.jsx:38 uses it for the comment timestamp. The date is also computed in the viewer's time zone, so near midnight it can differ from the server date, but no time is displayed.

```diff
--- a/frontend/src/components/CommentList/CommentList.jsx
+++ b/frontend/src/components/CommentList/CommentList.jsx
@@
-<span className="date-posted">{dateFormatter(createdAt)}</span>
+<span className="date-posted">{relativeTime(createdAt)}</span>
--- a/frontend/src/helpers/dateFormatter.js
+++ b/frontend/src/helpers/dateFormatter.js
@@
+export function relativeTime(date) {
+  const secs = Math.round((new Date(date) - Date.now()) / 1000);
+  if (Math.abs(secs) < 60) return "just now";
+  if (Math.abs(secs) < 3600)
+    return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round(secs / 60), "minute");
+  return new Date(date).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
+}
```

## `frontend/src/components/FavButton/FavButton.jsx` (1)

### S-205 [P2] Favorite on a deleted article after another user deletes it

**What broke:** Favorite on a deleted article gives no not-found feedback; the stale article stays shown and the 404 is only logged to the console

- Expected: The 404 shows a visible not-found message, and the article does not look favorited or intact.
- Actual: After the 404, the page still shows the full article with the Favorite button in its green filled style (count 0). The user sees no message. The only trace is the console errors 'Failed to load resource 404' and 'Article not found'. See screenshot after-click.png.
- Root cause: frontend/src/components/FavButton/FavButton.jsx:18-21 uses `.then(handler).catch(console.error)`, so a failed request is only logged. frontend/src/services/toggleFav.js:13-15 catches the axios error and calls errorHandler without rethrowing or returning an error state, so the caller gets `undefined`. The ArticlesButtons `handleFav` (ArticlesButtons.jsx:16) then destructures `undefined` and throws, and that error is also swallowed. Nothing in the UI reports the missing article.
- Screenshot: `.crashtest/shots/S-205/after-click.png`

```diff
--- a/frontend/src/components/FavButton/FavButton.jsx
+++ b/frontend/src/components/FavButton/FavButton.jsx
@@
     toggleFav({ slug, favorited, headers })
-      .then(handler)
-      .catch(console.error)
+      .then((article) => {
+        if (!article) throw new Error("Article not found. It may have been deleted.");
+        handler(article);
+      })
+      .catch((err) => {
+        console.error(err);
+        alert(err.message || "Article not found");
+      })
       .finally(() => setLoading(false));
```

## `frontend/src/components/AuthorInfo/AuthorInfo.jsx` (1)

### S-253 [P2] Unicode, emoji and HTML characters in bio are stored and rendered as text

**What broke:** Profile bio is rendered as Markdown/HTML, so <b> in the bio becomes real bold HTML

- Expected: Profile shows the literal text <b>bold</b>, with no HTML rendered.
- Actual: The profile shows 'bold' in bold and the tags are gone. The DOM contains an actual <b> element inside the bio <p>.
- Root cause: frontend/src/components/AuthorInfo/AuthorInfo.jsx:38 renders the bio with markdown-to-jsx's <Markdown>, which parses inline HTML tags in user-supplied text.
- Screenshot: `.crashtest/shots/S-253/profile.png`

```diff
--- a/frontend/src/components/AuthorInfo/AuthorInfo.jsx
+++ b/frontend/src/components/AuthorInfo/AuthorInfo.jsx
@@ -38 +38 @@
-      {bio && <Markdown options={{ forceBlock: true }}>{bio}</Markdown>}
+      {bio && <p>{bio}</p>}
```

## `frontend/src/services/userUpdate.js` (1)

### S-256 [P2] Network drops while saving settings

**What broke:** Saving settings while offline crashes the whole app to a blank page, with no error message and the form values lost

- Expected: A clear network error is shown, the form values are kept, and retry saves successfully
- Actual: The page goes completely blank with no error message and no form or button. The console shows a TypeError in AuthProvider. Retry is impossible without a reload, and the typed values are lost.
- Root cause: frontend/src/services/userUpdate.js:20-22 catches the error and calls errorHandler, which does not rethrow, so the function resolves to undefined. frontend/src/components/SettingsForm/SettingsForm.jsx:37-38 then runs `.then(setAuthState)` with undefined, so the auth state becomes undefined. AuthProvider (AuthContext.jsx:25) destructures `{headers,...}` from that undefined state and throws, which unmounts the app. SettingsForm.jsx:40 also sets `inactive` to true immediately, which hides the submit button even on failure. There is no error UI.

```diff
--- a/frontend/src/components/SettingsForm/SettingsForm.jsx
+++ b/frontend/src/components/SettingsForm/SettingsForm.jsx
@@
-    userUpdate({ headers, bio, email, image, password, username })
-      .then(setAuthState)
-      .catch(console.error);
-    setInactive(true);
+    setInactive(true);
+    setError(null);
+    userUpdate({ headers, bio, email, image, password, username })
+      .then((result) => {
+        if (result) setAuthState(result);
+        else throw new Error("Network error: could not save settings. Please try again.");
+      })
+      .catch((err) => {
+        setError(err.message || "Network error");
+        setInactive(false);
+      });
+  // also add: const [error, setError] = useState(null); and render {error && <p className="error-messages">{error}</p>}

```

## `frontend/src/components/SettingsForm/SettingsForm.jsx` (1)

### S-260 [P3] Enter a very long bio and an oversized image URL

**What broke:** 10,000-char bio is stored and rendered unwrapped on the profile page, causing massive horizontal overflow

- Expected: Either a clear length error on save, or the bio is stored and displayed without breaking the layout
- Actual: The save returns 200 with no length validation. The profile page's document scrollWidth is 92,895px against a clientWidth of 1,280px, so the page scrolls horizontally and the bio runs off-screen.
- Root cause: Nothing limits bio length. The settings textarea in frontend/src/components/SettingsForm/SettingsForm.jsx:66-68 has no maxLength, and I did not open the backend user update handler or model to confirm it has no limit either. frontend/src/components/AuthorInfo/AuthorInfo.jsx:38 renders the bio with <Markdown> and no overflow-wrap or word-break styling, so a long unbroken string never wraps.
- Screenshot: `.crashtest/shots/S-260/profile.png`

```diff
--- a/frontend/src/components/SettingsForm/SettingsForm.jsx
+++ b/frontend/src/components/SettingsForm/SettingsForm.jsx
@@ -66,3 +66,4 @@
               placeholder="Short bio about you"
               name="bio"
+              maxLength={500}
               value={bio}
--- a/frontend/src/components/AuthorInfo/AuthorInfo.jsx
+++ b/frontend/src/components/AuthorInfo/AuthorInfo.jsx
@@ -38 +38 @@
-      {bio && <Markdown options={{ forceBlock: true }}>{bio}</Markdown>}
+      {bio && <div style={{ overflowWrap: 'anywhere' }}><Markdown options={{ forceBlock: true }}>{bio}</Markdown></div>}

Also add a server-side length check on bio (for example, a 500-character limit in the backend user update handler or model) so oversized values are rejected with a 422.
```

## `backend/package.json` (1)

### S-288 [P2] Run the app with the MySQL dialect from the env example

**What broke:** Example env selects mysql but backend only ships pg, so the server crashes at startup and /api/tags is unreachable

- Expected: Backend connects with the configured dialect and GET /api/tags returns 200. Any mismatch between the mysql example and the installed pg driver is reported clearly.
- Actual: The process dies with an uncaught 'Please install mysql2 package manually' exception thrown while constructing Sequelize. It prints no dialect or connection message and does not mention the pg/mysql mismatch. Nothing serves /api/tags.
- Root cause: backend/.env.example sets all three *_DB_DIALECT values to mysql, but backend/package.json:16-17 lists only pg and pg-hstore and has no mysql2. backend/models/index.js:13 calls new Sequelize(...) outside any try/catch, so the missing driver is an uncaught crash. The try/catch in backend/index.js only wraps sequelize.sync. The example also misspells the logging variable as DEV_DB_LOGGGIN, while config/config.js reads DEV_DB_LOGGING.

```diff
--- a/backend/.env.example
+++ b/backend/.env.example
@@
-DEV_DB_DIALECT=mysql
+DEV_DB_DIALECT=postgres
-TEST_DB_DIALECT=mysql
+TEST_DB_DIALECT=postgres
-PROD_DB_DIALECT=mysql
+PROD_DB_DIALECT=postgres
(Alternatively, add "mysql2" to backend/package.json dependencies. Also rename the *_DB_LOGGGIN variables to *_DB_LOGGING.)
```
