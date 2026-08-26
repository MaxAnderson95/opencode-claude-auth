import assert from "node:assert/strict"
import { test } from "node:test"
import {
  OAUTH_AUTHORIZE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_METHOD_ID,
  OAUTH_SCOPES,
  OAUTH_TOKEN_URL,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  refreshCredential,
} from "./oauth.ts"

test("createAuthorizationRequest builds a PKCE authorization URL", () => {
  const request = createAuthorizationRequest("http://localhost:1234/callback")
  const url = new URL(request.url)
  assert.equal(url.origin + url.pathname, OAUTH_AUTHORIZE_URL)
  assert.equal(url.searchParams.get("client_id"), OAUTH_CLIENT_ID)
  assert.equal(url.searchParams.get("redirect_uri"), request.redirectUri)
  assert.equal(url.searchParams.get("scope"), OAUTH_SCOPES)
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("state"), request.state)
  assert.ok(url.searchParams.get("code_challenge"))
  assert.ok(request.verifier)
})

test("exchangeAuthorizationCode returns a native OpenCode credential", async () => {
  let capturedURL = ""
  let capturedBody = ""
  const credential = await exchangeAuthorizationCode(
    "authorization-code",
    {
      verifier: "verifier",
      redirectUri: "http://localhost:1234/callback",
      state: "state",
    },
    async (input, init) => {
      capturedURL = String(input)
      capturedBody = String(init?.body)
      return new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        }),
      )
    },
  )

  assert.equal(capturedURL, OAUTH_TOKEN_URL)
  assert.deepEqual(JSON.parse(capturedBody), {
    grant_type: "authorization_code",
    code: "authorization-code",
    state: "state",
    code_verifier: "verifier",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: "http://localhost:1234/callback",
  })
  assert.equal(credential.type, "oauth")
  assert.equal(credential.methodID, OAUTH_METHOD_ID)
  assert.equal(credential.access, "access")
  assert.equal(credential.refresh, "refresh")
  assert.ok(credential.expires > Date.now())
})

test("refreshCredential preserves a non-rotated refresh token and metadata", async () => {
  const credential = await refreshCredential(
    {
      type: "oauth",
      methodID: OAUTH_METHOD_ID as never,
      access: "old-access",
      refresh: "old-refresh",
      expires: 1,
      metadata: { label: "Work" },
    },
    async () =>
      new Response(
        JSON.stringify({ access_token: "new-access", expires_in: 3600 }),
      ),
  )

  assert.equal(credential.access, "new-access")
  assert.equal(credential.refresh, "old-refresh")
  assert.deepEqual(credential.metadata, { label: "Work" })
})
