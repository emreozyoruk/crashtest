# Findings — Kutt

✅ 97 passed · ❌ 31 broken · ⏭ 13 skipped · ⬜ 0 not run

## `server/handlers/validators.handler.js` (9)

### S-062 [P1] Reject malformed or non-http target values

**What broke:** Target validation accepts ftp:// URLs and gives only a generic error for javascript: URLs

- Expected: All three values are rejected with a validation error on target, and no link is created.
- Actual: 'ftp://example.com/file' was created as a short link and shown in the table. 'javascript:alert(1)' got a generic "An error occurred." rather than a target validation message. Only 'not a url' got "URL is not valid."
- Root cause: server/handlers/validators.handler.js:29 (also :108, :187, :213) has `utils.urlRegex.test(value) || /^(?!https?|ftp)(\w+:|\/\/)/.test(value)`. server/utils/utils.js:26 urlRegex explicitly allows the `ftp:` scheme, so ftp URLs pass. The fallback regex lets any non-http/ftp scheme with `\w+:`, such as `javascript:`, pass the validator. Something later in the pipeline then fails with a generic error that has no target field error.
- Screenshot: `.crashtest/shots/S-062/step3.png`

```diff
--- a/server/handlers/validators.handler.js
+++ b/server/handlers/validators.handler.js
@@ createLink (line 29; apply the same change at lines 108, 187 and 213)
-    .custom(value => utils.urlRegex.test(value) || /^(?!https?|ftp)(\w+:|\/\/)/.test(value))
+    .custom(value => /^https?:\/\//i.test(value) && utils.urlRegex.test(value))
--- a/server/utils/utils.js
+++ b/server/utils/utils.js
@@ line 26
-const urlRegex = /^(?:(?:(?:https?|ftp):)?\/\/)...
+const urlRegex = /^(?:(?:(?:https?):)?\/\/)...
```

### S-063 [P1] Block a target whose host is on the banned-domain list

**What broke:** Banned-domain check only matches the exact host, so subdomains of a banned domain can be shortened

- Expected: Both https://evil.example/landing and https://sub.evil.example/x are rejected with a banned-link error and no link is saved.
- Actual: The first is rejected (400 'Domain is banned.'). The second returns 201 and is saved (address GBzcnU, target https://sub.evil.example/x).
- Root cause: server/handlers/validators.handler.js:504-513 bannedDomain() does query.domain.find({address: domain, banned: true}), an exact-equality lookup. links.handler.js:103 and :118 pass only the hostname with www stripped, so sub.evil.example never matches the banned entry evil.example. The edit paths at links.handler.js:219 and :312 use the same check.

```diff
--- a/server/handlers/validators.handler.js
+++ b/server/handlers/validators.handler.js
@@ async function bannedDomain(domain) {
-  const isBanned = await query.domain.find({
-    address: domain,
-    banned: true
-  });
+  const parts = (domain || "").split(".");
+  const candidates = parts.map((_, i) => parts.slice(i).join(".")).filter(c => c.includes("."));
+  let isBanned = null;
+  for (const address of candidates) {
+    isBanned = await query.domain.find({ address, banned: true });
+    if (isBanned) break;
+  }
```

### S-106 [P1] Visiting a link whose target is a malicious scheme

**What broke:** Links with data: targets are accepted and the server redirects visitors to them

- Expected: Targets with a javascript:/data:/vbscript: scheme are rejected at creation, or the visit shows an error or safe page.
- Actual: POST /api/v2/links with a data:text/html target returned 201 and a short link. GET /VHK87c returned 302 with Location: data:text/html,... . Chromium blocked it with ERR_UNSAFE_REDIRECT; other clients may not.
- Root cause: server/handlers/validators.handler.js:29 (also line 108) has `|| /^(?!https?|ftp)(\w+:|\/\/)/.test(value)`, which accepts any non-http/ftp scheme, including data: and javascript:. The redirect at server/handlers/links.handler.js:544 (`res.redirect(link.target)`) and the HX-Redirect at line 577 use the stored target without checking its scheme. A javascript: target only fails because URL.parse(target).hostname is null in the later domain check, which gives a generic 500-style error.

```diff
--- a/server/handlers/validators.handler.js
+++ b/server/handlers/validators.handler.js
@@ -29 +29 @@
-    .custom(value => utils.urlRegex.test(value) || /^(?!https?|ftp)(\w+:|\/\/)/.test(value))
+    .custom(value => (utils.urlRegex.test(value) || /^(?!https?|ftp)(\w+:|\/\/)/.test(value)) && !/^\s*(javascript|data|vbscript|file|blob):/i.test(value))
@@ -108 +108 @@
-    .custom(value => utils.urlRegex.test(value) || /^(?!https?|ftp)(\w+:|\/\/)/.test(value))
+    .custom(value => (utils.urlRegex.test(value) || /^(?!https?|ftp)(\w+:|\/\/)/.test(value)) && !/^\s*(javascript|data|vbscript|file|blob):/i.test(value))
```

### S-191 [P1] Reject custom domain that is the default app domain

**What broke:** Adding the default domain gives generic 'Domain is not valid.' instead of a 'not allowed' error; the default-domain check is also unreliable

- Expected: Error stating the default domain is not allowed ("You can't use the default domain."); no domain created
- Actual: 400 {"error":"Domain is not valid."} for address localhost:3000, and no domain was created. The dedicated default-domain check was never hit.
- Root cause: server/handlers/validators.handler.js:172 runs urlRegex, which requires a dotted TLD, so a default domain such as localhost:3000 fails first and gives the generic message. If the regex passes, line 175 reduces the address to parsed.hostname, which drops the port. Line 177 then compares that to env.DEFAULT_DOMAIN, which includes the port, so a default domain with a port is not caught. The same applies to addDomainAdmin at lines 199-203.

```diff
--- a/server/handlers/validators.handler.js
+++ b/server/handlers/validators.handler.js
@@ -168,9 +168,9 @@
     .isLength({ min: 3, max: 64 })
     .withMessage("Domain length must be between 3 and 64.")
     .trim()
     .customSanitizer(utils.addProtocol)
+    .custom(value => utils.removeWww(URL.parse(value)?.host) !== env.DEFAULT_DOMAIN)
+    .withMessage("You can't use the default domain.")
     .custom(value => utils.urlRegex.test(value))
     .customSanitizer(value => {
       const parsed = URL.parse(value);
       return utils.removeWww(parsed.hostname || parsed.href);
     })
-    .custom(value => value !== env.DEFAULT_DOMAIN)
-    .withMessage("You can't use the default domain.")
```

### S-193 [P1] Reject banned custom domain

**What broke:** Adding a banned domain is rejected with a generic "You can't add this domain." message instead of a banned error

- Expected: Error saying the domain is banned; no domain created
- Actual: 400 {"error":"You can't add this domain."}; no domain created, but the message does not mention a ban and is identical to the already-taken case
- Root cause: server/handlers/validators.handler.js:179-183 - the addDomain validator rejects both domain.user_id (taken) and domain.banned with one shared message, "You can't add this domain."

```diff
--- a/server/handlers/validators.handler.js
+++ b/server/handlers/validators.handler.js
@@ -178,6 +178,10 @@
     .withMessage("You can't use the default domain.")
     .custom(async value => {
       const domain = await query.domain.find({ address: value });
-      if (domain?.user_id || domain?.banned) return Promise.reject();
-    })
-    .withMessage("You can't add this domain."),
+      if (domain?.banned) return Promise.reject("Domain is banned.");
+      if (domain?.user_id) return Promise.reject("You can't add this domain.");
+    }),
```

### S-194 [P1] Reject malformed domain strings

**What broke:** Domain validator accepts URLs with paths, trailing-dot hostnames and unicode lookalike domains

- Expected: Each of the four submissions is rejected with a validation error and nothing is stored.
- Actual: Only the space-containing and the script-tag inputs were rejected. 'http://bad.test/path' was stored as bad.test, 'trailing.test.' was stored with its trailing dot, and the Cyrillic lookalike was stored as xn--ggle-55da.test.
- Root cause: server/handlers/validators.handler.js:165-183 (addDomain). The address goes through utils.addProtocol and a permissive urlRegex. The sanitizer at lines 173-176 reduces any URL to its hostname, so the scheme and path are silently dropped instead of rejected. Nothing checks for a trailing dot or non-ASCII characters. addDomainAdmin at lines 191-209 has the same pattern.
- Screenshot: `.crashtest/shots/S-194/final.png`

```diff
--- a/server/handlers/validators.handler.js
+++ b/server/handlers/validators.handler.js
@@ const addDomain = [
     .withMessage("Domain length must be between 3 and 64.")
     .trim()
+    .custom(value => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value))
+    .withMessage("Domain is not valid.")
     .customSanitizer(utils.addProtocol)

```

### S-195 [P1] Reject invalid homepage URL

**What broke:** Domain homepage validation accepts javascript: and other non-http schemes

- Expected: Homepage 'javascript:alert(1)' is rejected with 'Homepage is not valid.' and the domain is not saved.
- Actual: The domain was created and 'javascript:alert(1)' is shown as its homepage in the domains table. The server later redirects to it, and the admin view renders it as a link href.
- Root cause: server/handlers/validators.handler.js:187 (addDomain) and :213 (addDomainAdmin) use `.custom(value => utils.urlRegex.test(value) || /^(?!https?|ftp)(\w+:|\/\/)/.test(value))`. The second alternative accepts any non-http(s)/ftp scheme, including javascript:, data: and vbscript:. utils.addProtocol (utils.js:78) leaves values with a scheme unchanged, so they get through.
- Screenshot: `.crashtest/shots/S-195/page-2026-10-10T11-45-43-652Z.png`

```diff
--- a/server/handlers/validators.handler.js
+++ b/server/handlers/validators.handler.js
@@ addDomain homepage
-    .custom(value => utils.urlRegex.test(value) || /^(?!https?|ftp)(\w+:|\/\/)/.test(value))
+    .custom(value => utils.urlRegex.test(value))
@@ addDomainAdmin homepage
-    .custom(value => utils.urlRegex.test(value) || /^(?!https?|ftp)(\w+:|\/\/)/.test(value))
+    .custom(value => utils.urlRegex.test(value))
```

### S-282 [P1] Admin edit link rejects an invalid target URL

**What broke:** PATCH /links/:id with 'javascript:alert(1)' or an empty target returns 500 instead of a 400 validation error

- Expected: All three invalid targets return 400 with a validation error.
- Actual: 'not a url' returned 400. 'javascript:alert(1)' returned 500 {error: An error occurred.}. The empty target returned 500 {error: Should at least update one field.}. The stored target was not changed.
- Root cause: Empty target: server/handlers/validators.handler.js:102 makes target optional with checkFalsy, so an empty value skips validation. server/handlers/links.handler.js:205 (and :298) then throws CustomError without a status code, which defaults to 500. 'javascript:alert(1)': the second clause of the custom check at validators.handler.js:108 accepts any non-http scheme, so the validator does not reject it. I did not find where the 500 is thrown after that; it is probably a later step in the handler. Either way the request is not rejected with a 400.

```diff
--- a/server/handlers/links.handler.js
+++ b/server/handlers/links.handler.js
@@ -204,2 +204,2 @@
   if (!isChanged) {
-    throw new CustomError("Should at least update one field.");
+    throw new CustomError("Should at least update one field.", 400);
(same change at line 298; also drop the permissive non-http scheme clause at validators.handler.js:108 so javascript: targets fail validation with 400)
```

### S-286 [P1] Admin deletes a domain without deleting its links

**What broke:** Deleting a domain with links=false still deletes all its links

- Expected: Domain is removed. The links stay, with domain_id cleared, so they fall back to the default domain and still appear in the owner's Links list.
- Actual: The domain and all three links were deleted. The short URL no longer works and the owner has no links left.
- Root cause: server/handlers/validators.handler.js:18 defines sanitizeCheckbox = v => v === true || v === 'on' || v, which returns the string 'false' unchanged. server/handlers/domains.handler.js:97 then runs `if (links)`, and the string 'false' is truthy, so query.link.batchRemove runs. Separately, when links are kept, nothing sets domain_id to null on them (domain.queries.js:213).

```diff
--- a/server/handlers/domains.handler.js
+++ b/server/handlers/domains.handler.js
@@ removeAdmin
-  const links = req.query.links
+  const links = req.query.links === true || req.query.links === "true" || req.query.links === "on";
   ...
   if (links) {
     await query.link.batchRemove({ domain_id: id });
+  } else {
+    await query.link.update({ domain_id: id }, { domain_id: null });
   }
```

## `server/handlers/links.handler.js` (6)

### S-069 [P1] Two tabs create the same custom address at once

**What broke:** Concurrent creation of same custom address produces duplicate links (no unique constraint, check-then-insert race)

- Expected: Exactly one link keeps race1; the other gets 'Custom URL is already in use'; no duplicate rows.
- Actual: Both tabs created a link at localhost:3000/race1. The links table has two race1 rows pointing to different targets. Neither tab showed an error.
- Root cause: server/handlers/links.handler.js:99-135 checks existence with query.link.find and later inserts, which is not atomic. The only index on links.address is a non-unique `links_address_index` (server/migrations/20241223062111_indexes.js:23), so the DB does not reject the duplicate. Two requests can both pass the check, then both insert.
- Screenshot: `.crashtest/shots/S-069/tab1.png`

```diff
--- a/server/migrations/<new>_unique_link_address.js
+++ b/server/migrations/<new>_unique_link_address.js
+exports.up = async knex => {
+  await knex.raw('CREATE UNIQUE INDEX links_address_domain_unique ON links (address, COALESCE(domain_id, 0))');
+};
--- a/server/queries/link.queries.js
+++ b/server/queries/link.queries.js
@@ create()
+  // catch unique-violation on insert and rethrow CustomError("Custom URL is already in use.")
(Existing duplicates must be cleaned up before the migration runs.)
```

### S-105 [P1] Link expiry passes and visit no longer redirects

**What broke:** Expired link still redirects to its target

- Expected: A link whose expire_in is in the past returns 404 or an expired page and does not redirect.
- Actual: GET /s105exp returned 302 with Location https://example.com/expired. The browser ended on the target site.
- Root cause: The redirect handler (server/handlers/links.handler.js:459-544) never compares link.expire_in with the current time. query.link.find (server/queries/link.queries.js:179-198) doesn't filter on it either. The only enforcement is the 30s cron batchRemove in server/cron.js:5-7, so expired links keep redirecting until the cron deletes them. With Redis enabled they can stay cached for up to 15 minutes (link.queries.js:192-195). The row was still present after my visit, so the cron had not deleted it by then.
- Screenshot: `.crashtest/shots/S-105/redirected.png`

```diff
--- a/server/handlers/links.handler.js
+++ b/server/handlers/links.handler.js
@@ async function redirect(req, res, next) {
   if (!link) {
     return res.redirect(domain?.homepage || "/404");
   }
+
+  if (link.expire_in && new Date(link.expire_in) < new Date()) {
+    return res.redirect("/404");
+  }
```

### S-134 [P1] Edit a link I do not own

**What broke:** PATCH on another user's link returns 500 instead of 404

- Expected: Refusal with HTTP 404 or 403, and B's link unchanged.
- Actual: HTTP 500 with body {"error":"Link was not found."}. B's link was unchanged.
- Root cause: server/handlers/links.handler.js:170 (edit) and :263 (editAdmin) throw new CustomError("Link was not found.") with no status code. CustomError defaults statusCode to 500 (server/utils/utils.js:19).

```diff
--- a/server/handlers/links.handler.js
+++ b/server/handlers/links.handler.js
@@ -167,5 +167,5 @@
   if (!link) {
-    throw new CustomError("Link was not found.");
+    throw new CustomError("Link was not found.", 404);
   }
@@ -260,5 +260,5 @@
   if (!link) {
-    throw new CustomError("Link was not found.");
+    throw new CustomError("Link was not found.", 404);
   }
```

### S-138 [P1] Delete another user's link via API

**What broke:** Deleting another user's link is refused with HTTP 500 instead of 404/403

- Expected: 404 or 403 when user A deletes user B's link; the link stays intact.
- Actual: HTTP 500 {"error":"Could not find the link."}. The link is not deleted, so ownership is enforced; only the status code is wrong.
- Root cause: server/handlers/links.handler.js:355-358: when query.link.remove reports isRemoved=false, the handler throws a bare CustomError(message) with no status code, so the error handler defaults to 500. The message comes from server/queries/link.queries.js:236.

```diff
--- a/server/handlers/links.handler.js
+++ b/server/handlers/links.handler.js
@@ -355,4 +355,4 @@
   if (!isRemoved) {
     const messsage = error || "Could not delete the link.";
-    throw new CustomError(messsage);
+    throw new CustomError(messsage, 404);
   }
```

### S-140 [P1] Read stats of another user's link

**What broke:** Stats API returns HTTP 500 instead of 403/404 when requesting another user's link

- Expected: GET /api/v2/links/:id/stats for a link owned by another user returns 403 or 404, and the stats page shows no data
- Actual: API returns HTTP 500 {"error":"Link could not be found."}. No data is leaked, and the browser stats page redirects to /404.
- Root cause: server/handlers/links.handler.js:625 throws `new CustomError("Link could not be found.")` with no status argument, so CustomError defaults to 500. The ownership filter at lines 614-617 works correctly.
- Screenshot: `.crashtest/shots/S-140/stats.png`

```diff
--- a/server/handlers/links.handler.js
+++ b/server/handlers/links.handler.js
@@ -625 +625 @@
-    throw new CustomError("Link could not be found.");
+    throw new CustomError("Link could not be found.", 404);
```

### S-346 [P1] Cached domain data is not used after a custom domain is disabled

**What broke:** Short links on a banned custom domain still redirect (domain.banned is never checked in redirect)

- Expected: After an admin bans the domain, visiting a short URL on it no longer redirects to the target, and the cache does not keep the domain active.
- Actual: Banning invalidates the cached domain, so the next lookup reads banned=true from the database. The redirect handler ignores that flag and serves the link. The link's own `banned` flag is only set when the admin chose to ban links too. This was not observed live.
- Root cause: server/handlers/links.handler.js:466-489 (`redirect`) looks up the domain via `query.domain.find` but only checks `link.banned`, never `domain.banned`. `ban` in server/handlers/domains.handler.js:175-186 updates the domain row and clears the cache (domain.queries.js:77-80). It bans the links only when `req.body.links` is set. A grep for `domain.banned` shows no check on the redirect path.

```diff
--- a/server/handlers/links.handler.js
+++ b/server/handlers/links.handler.js
@@ async function redirect(req, res, next) {
       : null;
 
+  // banned custom domain: do not serve redirects
+  if (domain?.banned) {
+    return res.redirect("/banned");
+  }
+
   // 2. Get link
```

## `server/handlers/auth.handler.js` (3)

### S-003 [P1] Race two create-admin requests on an empty install

**What broke:** Race condition in /api/auth/create-admin allows creating multiple ADMIN users on a fresh install

- Expected: Exactly one ADMIN user is created from the two concurrent requests; the second request returns HTTP 400 ('a user already exists') and no duplicate admin rows exist.
- Actual: Both concurrent POST /api/auth/create-admin requests returned HTTP 201 with valid JWT tokens. The users table ended up with two ADMIN rows (admin1@race.test id=2, admin2@race.test id=3), and both accounts could independently log in via POST /api/auth/login, proving two fully functional admin accounts exist on what was supposed to be a single-admin fresh install.
- Root cause: server/handlers/auth.handler.js:116-130 createAdminUser() does a check-then-act with no transaction/locking: it calls `await query.user.findAny()` (line 117) to see if any user exists, and only if none exists proceeds to hash the password and `await query.user.add(...)` (line 125) to insert the new admin. Between the findAny() check and the add() insert there are two awaited async operations (bcrypt hashing + DB write), giving a wide window where two concurrent requests both pass the findAny() check (both see zero users) before either has inserted a row, so both succeed and insert distinct ADMIN rows. There is no unique constraint or DB-level atomic guard (e.g. a unique partial index on role=ADMIN, or a transaction with SELECT ... FOR UPDATE / INSERT ... WHERE NOT EXISTS) preventing this.
- Screenshot: `.crashtest/shots/S-003/settings-logged-in-admin1.png`

```diff
--- a/server/handlers/auth.handler.js
+++ b/server/handlers/auth.handler.js
@@ -114,11 +114,18 @@
 async function createAdminUser(req, res) {
-  const isThereAUser = await query.user.findAny();
-  if (isThereAUser) {
-    throw new CustomError("Can not create the admin user because a user already exists.", 400);
-  }
-
   const salt = await bcrypt.genSalt(12);
   const password = await bcrypt.hash(req.body.password, salt);

-  const user = await query.user.add({
-    email: req.body.email, 
-    password, 
-    role: ROLES.ADMIN, 
-    verified: true 
-  });
+  // Perform the existence check and insert atomically inside a single
+  // DB transaction (with a row lock / unique constraint) so two concurrent
+  // requests cannot both pass the check before either has inserted a row.
+  let user;
+  try {
+    user = await knex.transaction(async trx => {
+      const isThereAUser = await query.user.findAny(trx).forUpdate();
+      if (isThereAUser) {
+        throw new CustomError("Can not create the admin user because a user already exists.", 400);
+      }
+      return query.user.add({
+        email: req.body.email,
+        password,
+        role: ROLES.ADMIN,
+        verified: true
+      }, trx);
+    });
+  } catch (err) {
+    throw err instanceof CustomError ? err : new CustomError("Can not create the admin user because a user already exists.", 400);
+  }

```

### S-032 [P1] Reject a tampered or unknown verification token

**What broke:** /verify/:token logs in as an already-verified user whose verification_token is still set

- Expected: A token belonging to an already verified user shows the invalid-token message and sets no session.
- Actual: GET /verify/ec7d0d91-6bc7-49ab-834b-6cffb487c7ba (admin1@race.test, verified=1, token unexpired) redirected to / and signed the browser in as admin (Admin and Log out links visible). The token was consumed.
- Root cause: server/handlers/auth.handler.js:158-168: the update matches only on verification_token and an unexpired verification_expires. It never checks verified=false. If a verified user still has a token and expiry (here seeded that way), the token grants a signed JWT (lines 170-176). Anyone holding such a token gets a session.
- Screenshot: `.crashtest/shots/S-032/verified-user-token.png`

```diff
--- a/server/handlers/auth.handler.js
+++ b/server/handlers/auth.handler.js
@@ async function verify(req, res, next) {
   const user = await query.user.update(
     {
       verification_token: req.params.verificationToken,
+      verified: false,
       verification_expires: [">", utils.dateToUTC(new Date())]
     },
```

### S-183 [P1] Generate API key and see it once

**What broke:** API key is shown in full on every Settings page load instead of only once

- Expected: After reload the full API key is no longer shown, or it is masked.
- Actual: After reload the Settings page renders the full plaintext 40-character key again, in the paragraph and in the copy button's data-url.
- Root cause: The key is stored in plaintext in users.apikey (server/handlers/auth.handler.js:211-218). The settings partial server/views/partials/settings/apikey.hbs:12-29 renders {{user.apikey}} whenever the user has a key, and the settings page passes the full user record. Nothing distinguishes a freshly generated key from a stored one.
- Screenshot: `.crashtest/shots/S-183/reload.png`

```diff
--- a/server/views/partials/settings/apikey.hbs
+++ b/server/views/partials/settings/apikey.hbs
@@
-    {{#if user.apikey}}
+    {{#if user.apikey_new}}
 ...
-        data-url="{{user.apikey}}"
+        data-url="{{user.apikey_new}}"
 ...
-        {{user.apikey}}
+        {{user.apikey_new}}
+    {{else if user.apikey}}
+      <p>••••••••••••••••••••••••••••••••{{user.apikey_last4}}</p>
     {{/if}}

--- a/server/handlers/auth.handler.js
@@ generateApiKey
-      user: { apikey },
+      user: { apikey, apikey_new: apikey },

(The button label, {{#if user.apikey}}Reg{{else}}G{{/if}}enerate key, needs a separate flag, e.g. has_apikey, so a masked state still reads "Regenerate". The GET /settings handler should pass apikey_last4 and has_apikey, not the raw key.)
```

## `server/routes/link.routes.js` (2)

### S-102 [P1] Brute forcing a link password is slowed down

**What broke:** POST /api/links/:id/protected has no rate limiting, allowing unlimited password brute-forcing

- Expected: After the rate limit threshold is reached, the endpoint should respond 429 and keep refusing requests until the window resets; the correct password should not be accepted while rate-limited.
- Actual: Sent 140 consecutive wrong-password requests (40 + 100) to POST /api/links/d4c3e66e-07eb-4c12-beba-d6f89c613258/protected; every single one returned 401 with zero 429 responses. Immediately afterward, the correct password was submitted and accepted with HTTP 200, returning the protected target URL with no delay or lockout. The route is completely unthrottled.
- Root cause: server/routes/link.routes.js:100-107 defines the POST /:id/protected route without any rate-limiting middleware. Kutt does have a reusable rate-limit factory at server/handlers/helpers.handler.js:88 (helpers.rateLimit) which IS applied to auth routes (server/routes/auth.routes.js lines 19,30,41,51,62,70,80,90, e.g. limit 5/60s for login) but it is never attached to the protected-link password-check route. Additionally, helpers.rateLimit is gated behind env.ENABLE_RATE_LIMIT (server/handlers/helpers.handler.js:88-93), which defaults to false (server/env.js:73) and is not set in the running .env, so even the existing auth-route protections are currently disabled app-wide — compounding the issue for this route even if it had been wired up.

```diff
--- a/server/routes/link.routes.js
+++ b/server/routes/link.routes.js
@@ -97,10 +97,11 @@
 router.post(
   "/:id/protected",
   locals.viewTemplate("partials/protected/form"),
   locals.protected,
+  helpers.rateLimit({ window: 60, limit: 5 }),
   validators.redirectProtected,
   asyncHandler(helpers.verify),
   asyncHandler(link.redirectProtected)
 );

```

### S-252 [P1] Report spam is rate limited

**What broke:** POST /api/links/report has no rate limiting, so report spam is never answered with 429

- Expected: After the configured limit is exceeded, the report endpoint returns 429. Earlier requests succeed and no more emails are sent.
- Actual: 15 consecutive requests all returned 400 and none returned 429. The route has no rate-limit middleware, so with mail enabled every valid report would send an email.
- Root cause: server/routes/link.routes.js:109-116 defines POST /report without helpers.rateLimit(...). The auth routes use it (auth.routes.js:19 and others), but the report route does not. helpers.rateLimit (helpers.handler.js:88) also returns a no-op when env.ENABLE_RATE_LIMIT is false (env.js:73, default false).

```diff
--- a/server/routes/link.routes.js
+++ b/server/routes/link.routes.js
@@ router.post(
   "/report",
   locals.viewTemplate("partials/report/form"),
   auth.featureAccess([env.MAIL_ENABLED]),
+  helpers.rateLimit({ window: 60, limit: 5 }),
   validators.reportLink,
```

## `server/env.js` (2)

### S-176 [P1] Block change password after five attempts per minute

**What broke:** change-password has no effective rate limit: sixth wrong-password attempt returns 401, not 429

- Expected: Attempts 1-5 return a password-incorrect error; attempt 6 returns HTTP 429.
- Actual: All six attempts returned 401 {"error":"Current password is not correct."}. No 429.
- Root cause: server/env.js:73 defines ENABLE_RATE_LIMIT with default false, and the repo .env doesn't set it. server/handlers/helpers.handler.js:89-93 therefore turns rateLimit() into a no-op, so the limiter on /change-password (server/routes/auth.routes.js:51) never runs. Even with the limiter enabled, it is mounted after the validator and helpers.verify, so it only guards requests that get past validation. The current-password check happens later, in auth.handler.js:181-187.

```diff
--- a/server/env.js
+++ b/server/env.js
-  ENABLE_RATE_LIMIT: bool({ default: false }),
+  ENABLE_RATE_LIMIT: bool({ default: true }),

Alternatively, set ENABLE_RATE_LIMIT=true in .env and let the app enforce it. Also move helpers.rateLimit before validators.changePassword in server/routes/auth.routes.js so validation failures count toward the limit.
```

### S-229 [P1] Brute-force new-password attempts are rate limited

**What broke:** /api/auth/new-password is not rate limited unless ENABLE_RATE_LIMIT is set, and it defaults to false

- Expected: The sixth request, and every one after the fifth in a minute, returns HTTP 429
- Actual: All six requests returned 500. No 429 appeared, so unlimited token guessing is possible.
- Root cause: server/env.js:73 sets ENABLE_RATE_LIMIT with default false. helpers.rateLimit (server/handlers/helpers.handler.js:88-93) then returns a no-op middleware, so the limit of 5 per 60s at server/routes/auth.routes.js:90 never applies. The running instance has no ENABLE_RATE_LIMIT set. Also, the invalid-token path returns 500 rather than a client error.

```diff
--- a/server/env.js
+++ b/server/env.js
-  ENABLE_RATE_LIMIT: bool({ default: false }),
+  ENABLE_RATE_LIMIT: bool({ default: true }),
```

## `server/queries/user.queries.js` (1)

### S-001 [P1] Create the first admin from the create-admin page

**What broke:** Create-admin issues a JWT with no sub, so the new admin is not signed in and lands on /login

- Expected: After creating the admin, the auth cookie identifies the new user and they land on the logged-in dashboard.
- Actual: The token cookie decodes to {iss, iat, exp} with no sub. The next request to / returns 302 to /login, and the user ends up on the login page.
- Root cause: server/queries/user.queries.js:54-64: add() inserts a new user with knex('users').insert(data) and returns {...user, ...data}. user is undefined for a new insert and data has no id, so the returned object has no id. createAdminUser (server/handlers/auth.handler.js:125-132) then calls utils.signToken(user), which sets sub: user.id (server/utils/utils.js:42) to undefined. JWT auth then fails.
- Screenshot: `.crashtest/shots/S-001/after.png`

```diff
--- a/server/queries/user.queries.js
+++ b/server/queries/user.queries.js
@@ async function add(params, user) {
+  let inserted;
   if (user) {
     ...
   } else {
-    await knex("users").insert(data);
+    [inserted] = await knex("users").insert(data).returning("*");
   }
@@
   return {
     ...user,
-    ...data
+    ...data,
+    ...inserted
   };
```

## `server/handlers/helpers.handler.js` (1)

### S-026 [P1] Block login for a banned account

**What broke:** Banned user's /login form submission returns HTTP 200 (error HTML) instead of 403

- Expected: Both the /login form submission and POST /api/auth/login are rejected with 403 and a banned message, with no token.
- Actual: The API call returns 403 as expected. The form (HTMX) POST to /api/auth/login returns 200 with the form re-rendered and "You're banned from using this website.". No token or cookie is set, so the block works and only the status code differs.
- Root cause: server/handlers/helpers.handler.js:20-23: when req.isHTML && req.viewTemplate, the error handler calls res.render(viewTemplate) without setting res.status(statusCode). The 403 thrown at server/handlers/auth.handler.js:52-54 is therefore sent as 200. This may be deliberate, since htmx does not swap 4xx responses by default.
- Screenshot: `.crashtest/shots/S-026/final.png`

```diff
--- a/server/handlers/helpers.handler.js
+++ b/server/handlers/helpers.handler.js
@@ -19,5 +19,6 @@
   if (req.isHTML && req.viewTemplate) {
     res.locals.error = message;
-    res.render(req.viewTemplate);
+    res.status(statusCode).render(req.viewTemplate);
     return;
   }

(Also configure htmx to swap 4xx/403 responses, e.g. via htmx:beforeSwap with evt.detail.shouldSwap = true, so the error still renders.)
```

## `server/views/partials/settings/delete_account.hbs` (1)

### S-187 [P1] Cancel account deletion keeps account

**What broke:** Delete account has no confirmation dialog, so there is no way to cancel before the request is sent

- Expected: Delete opens a confirmation dialog; cancel or dismiss sends no request and the account and links remain, and the user stays signed in.
- Actual: Clicking Delete submits the form straight away. POST /api/users/delete went out with no dialog and nothing to cancel. A password-less click was only rejected by the server ('Password is not valid.'); with the correct password the account would be deleted at once.
- Root cause: server/views/partials/settings/delete_account.hbs:6-34 — the form uses hx-post="/api/users/delete" and the Delete button is type=submit. There is no hx-confirm, no modal, and no cancel button.
- Screenshot: `.crashtest/shots/S-187/dialog.png`

```diff
--- a/server/views/partials/settings/delete_account.hbs
+++ b/server/views/partials/settings/delete_account.hbs
@@
   <form 
     id="delete-account"
     hx-post="/api/users/delete"
+    hx-confirm="Are you sure you want to delete your account? This cannot be undone."
     hx-select="form"
```

## `server/handlers/domains.handler.js` (1)

### S-197 [P1] Cannot remove another user's domain

**What broke:** Deleting another user's domain returns 400 instead of 403/404 (ownership is protected)

- Expected: 403 or 404, and B's domain still owned by B
- Actual: 400 Bad Request {"error":"Could not delete the domain."}. The domain remained owned by B.
- Root cause: server/handlers/domains.handler.js:52-59: the lookup is scoped to user_id: req.user.id, and a miss throws CustomError(..., 400). Not-found and not-owned are therefore reported as 400.

```diff
--- a/server/handlers/domains.handler.js
+++ b/server/handlers/domains.handler.js
@@ -57,3 +57,3 @@
   if (!domain) {
-    throw new CustomError("Could not delete the domain.", 400);
+    throw new CustomError("Domain not found.", 404);
   }
```

## `server/utils/utils.js` (1)

### S-227 [P1] Reject a malformed or wrong-length reset token

**What broke:** POST /new-password with an unknown (well-formed 36-char) reset token returns 500 with a generic message instead of a 4xx invalid-token error

- Expected: A 400 response saying the reset token is invalid or expired, as already happens for wrong-length tokens
- Actual: HTTP 500 {"error":"Could not set the password. Please try again later."}
- Root cause: server/handlers/auth.handler.js, newPassword: `throw new CustomError("Could not set the password. Please try again later.")` has no status code. CustomError defaults statusCode to 500 (server/utils/utils.js:21). The message also doesn't mention the token.
- Screenshot: `.crashtest/shots/S-227/37chars.png`

```diff
--- a/server/handlers/auth.handler.js
+++ b/server/handlers/auth.handler.js
@@ async function newPassword(req, res) {
   if (!user) {
-    throw new CustomError("Could not set the password. Please try again later.");
+    throw new CustomError("Reset password token is invalid or expired.", 400);
   }
```

## `server/mail/mail.js` (1)

### S-251 [P1] Reason text containing HTML is not rendered as markup in the report email

**What broke:** Report email puts the user-supplied link into the HTML part unescaped (HTML injection in the admin mailbox)

- Expected: The input is HTML-escaped or sent only as plain text, so no executable markup appears in the email's HTML part.
- Actual: The sink captured an email whose text/html part is exactly `http://localhost:3177/<script>alert(1)</script><img src=x>`, so the script and img tags are live markup.
- Root cause: server/mail/mail.js:130-131 in sendReportEmail passes the user-controlled `link` straight into `html: link`. server/handlers/validators.handler.js:252-263 only checks that the host equals DEFAULT_DOMAIN, so any path or query content passes. server/handlers/links.handler.js:377 forwards the value unchanged.

```diff
--- a/server/mail/mail.js
+++ b/server/mail/mail.js
@@ async function sendReportEmail(link) {
+  const escaped = String(link)
+    .replace(/&/g, "&amp;")
+    .replace(/</g, "&lt;")
+    .replace(/>/g, "&gt;")
+    .replace(/"/g, "&quot;")
+    .replace(/'/g, "&#39;");
   const mail = await transporter.sendMail({
     from: env.MAIL_FROM || env.MAIL_USER,
     to: env.REPORT_EMAIL,
     subject: "[REPORT]",
     text: link,
-    html: link
+    html: escaped
   });
```

## `static/scripts/main.js` (1)

### S-279 [P1] Admin cancels the delete dialog and nothing is deleted

**What broke:** Escape key does not close the admin Delete user dialog

- Expected: Escape closes the delete dialog, with the user and links unchanged.
- Actual: Escape does nothing and the dialog stays open (c.png). Cancel works (d.png). The user and link remain in the DB.
- Root cause: static/scripts/main.js:130-144 defines closeDialog() and registers only a window 'click' handler (backdrop click). There is no 'keydown' listener for Escape.
- Screenshot: `.crashtest/shots/S-279/c.png`

```diff
--- a/static/scripts/main.js
+++ b/static/scripts/main.js
@@ -144,0 +145,6 @@
+window.addEventListener("keydown", function(event) {
+  if (event.key !== "Escape") return;
+  const dialog = document.querySelector(".dialog.open");
+  if (dialog) closeDialog();
+});
+
```

## `server/handlers/locals.handler.js` (1)

### S-284 [P1] Admin adds a custom domain from the Domains tab

**What broke:** Admin-added unowned domain is not available as a domain option for links

- Expected: The new unowned, unbanned domain is also available as a domain option when creating links.
- Actual: The domain is saved with user_id NULL and shown as System-owned in the list. The link-creation domain dropdown only shows localhost:3000, so no user can pick the domain.
- Root cause: server/handlers/locals.handler.js:43 builds the link-form domain list with query.domain.get({ user_id: user.id }). The same filter is in server/handlers/users.handler.js:9 and :14 for the settings page. Admin-added domains have a NULL user_id (addAdmin in server/handlers/domains.handler.js:19-23 sets no user_id), so they never match any user and are never offered.
- Screenshot: `.crashtest/shots/S-284/home.png`

```diff
--- a/server/handlers/locals.handler.js
+++ b/server/handlers/locals.handler.js
@@ -43 +43 @@
-  res.locals.domains = user && (await query.domain.get({ user_id: user.id })).map(utils.sanitize.domain);
+  res.locals.domains = user && (await query.domain.getAvailable(user.id)).map(utils.sanitize.domain);

--- a/server/queries/domain.queries.js
+++ b/server/queries/domain.queries.js
@@ -23,3 +23,7 @@
 function get(match) {
   return knex("domains").where(match);
 }
+
+// domains owned by the user plus unowned (system) domains that are not banned
+function getAvailable(user_id) {
+  return knex("domains").where(b => b.where({ user_id }).orWhere(c => c.whereNull("user_id").where("banned", false)));
+}
(also add getAvailable to module.exports, and make sure the link-creation validator accepts system domains)
```

## `server/redis.js` (1)

### S-344 [P1] App falls back to inline visit recording when Redis is configured but unreachable at startup

**What broke:** With REDIS_ENABLED=true and Redis unreachable, redirects return 500 and no visits are recorded; there is no inline fallback

- Expected: Server starts and logs a clear Redis error. Redirects still work, and the visit is recorded inline or the failure is logged clearly.
- Actual: The server starts and only logs raw ioredis ECONNREFUSED spam. GET / and GET /<short> return 500 (MaxRetriesPerRequestError). The visit count stays 0.
- Root cause: server/redis.js:8-13 creates the ioredis client with default retry settings and no 'error' handler or fallback. Every request path awaits redis.client.get (host.queries.js:8, domain.queries.js:8, visit.queries.js:72), so each one stalls for 20 retries and then throws a 500. server/queues/queues.js:15-23 only builds the Bull queue when REDIS_ENABLED is true. There is no connectivity check and no fallback to the inline processor from the else branch at queues.js:25-33. The visit error handler is a commented-out TODO.

```diff
--- a/server/redis.js
+++ b/server/redis.js
@@
-  client = new Redis({
+  client = new Redis({
+    maxRetriesPerRequest: 1,
+    enableOfflineQueue: false,
     host: env.REDIS_HOST,
@@
   });
+  client.on("error", (err) => console.error("Redis connection error (host=%s port=%s): %s", env.REDIS_HOST, env.REDIS_PORT, err.message));
 }

Also, in the cache read/write call sites, either guard with `client.status === "ready"` or wrap the calls in try/catch. In server/queues/queues.js, use the inline visit processor in `add()` when the Redis client is not ready.
```
