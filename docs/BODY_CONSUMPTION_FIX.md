# Body Consumption Fix Summary

## Problem
The error "Body has already been used. It can only be used once. Use tee() first if you need to read it twice" was occurring in the webhook handler.

## Root Cause
The original code was trying to consume the request body multiple times:
1. Once for signature verification
2. Again for JSON parsing

Even when using `request.clone()`, the original request body was still being consumed.

## Solutions Applied

### 1. Modified Main Webhook Handler (`src/index.ts`)

**Before:**
```typescript
app.post('/github/webhook', async (c: HonoContext) => {
  return await handleWebhook(c.req.raw, c.env);
});
```

**After:**
```typescript
app.post('/github/webhook', async (c: HonoContext) => {
  // Read headers and body once
  const delivery = c.req.header('x-github-delivery') || ''
  const event = c.req.header('x-github-event') || ''
  const signature = c.req.header('x-hub-signature-256') || ''
  const bodyText = await c.req.text() // Read body once

  // Create webhook data object
  const webhookData = {
    delivery,
    event,
    signature,
    bodyText,
    headers: { /* ... */ }
  }

  return await handleWebhook(webhookData, c.env);
});
```

### 2. Updated Webhook Handler Signature (`src/routes/webhook.ts`)

**Before:**
```typescript
export async function handleWebhook(req: Request, env: Env)
```

**After:**
```typescript
type WebhookData = {
  delivery: string
  event: string
  signature: string
  bodyText: string
  headers: Record<string, string>
}

export async function handleWebhook(webhookData: WebhookData, env: Env)
```

### 3. Eliminated Body Re-reading

**Before:**
```typescript
const clonedReq = req.clone()
const bodyText = await clonedReq.text()
// ... signature verification ...
const payload = JSON.parse(bodyText)
```

**After:**
```typescript
const { bodyText } = webhookData
// ... signature verification with bodyText ...
const payload = JSON.parse(bodyText)
```

## Key Principles

1. **Read Once**: Read the request body exactly once in the main handler
2. **Pass Data**: Pass the body text as data, not as a Request object
3. **No Cloning**: Eliminate the need for request cloning by reading upfront
4. **Structured Data**: Use a typed data structure to pass webhook information

## Verbose Logging Added

Added comprehensive logging with prefixes:
- `[MAIN]`: Main webhook handler in index.ts
- `[WEBHOOK]`: Webhook processor in routes/webhook.ts

This will help identify exactly where any remaining body consumption issues occur.

## Testing

To test the fix:
1. Deploy the updated worker
2. Send a webhook to the endpoint
3. Check logs for successful processing without body consumption errors
4. Verify the verbose logs show the expected flow

## Prevention

This pattern should be used for all webhook handlers:
1. Read request body once in the main route handler
2. Pass body text and headers as structured data
3. Never pass Request objects to sub-handlers
4. Use type-safe data structures for webhook data
