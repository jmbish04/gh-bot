/**
 * Interface for the expected JSON payload from the webhook.
 */
interface WebhookPayload {
  eventId: string;
  eventType: 'USER_CREATED' | 'ITEM_UPDATED';
  data: {
    userId?: string;
    itemId?: string;
    message?: string;
  };
  timestamp: string;
}

export default {
  /**
   * Main fetch handler for the worker.
   * @param request - The incoming request object.
   * @param env - Environment variables, including the WEBHOOK_SECRET.
   * @param ctx - The execution context, used for background tasks.
   * @returns A Response object.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1. Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 2. Security: Verify the webhook signature
    const signature = request.headers.get('X-Signature');
    if (!signature) {
      return new Response('Missing signature', { status: 401 });
    }

    // FIXED: Clone the request and read body as text once
    const clonedRequest = request.clone();
    const bodyText = await clonedRequest.text();

    const isValid = await verifySignature(bodyText, signature, env.WEBHOOK_SECRET);

    if (!isValid) {
      return new Response('Invalid signature', { status: 401 });
    }

    // 3. Process the webhook payload
    try {
      // FIXED: Parse JSON from the already-read body text instead of calling request.json()
      const payload: WebhookPayload = JSON.parse(bodyText);

      // Use waitUntil to process the webhook without making the client wait.
      // This is ideal for calling other APIs, writing to a database, etc.
      ctx.waitUntil(processWebhook(payload));

      // 4. Respond immediately with a success message
      return new Response(JSON.stringify({ status: 'success', message: 'Webhook received' }), {
        status: 202, // Accepted
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Error processing webhook:', error);
      return new Response('Bad Request: Invalid JSON', { status: 400 });
    }
  },
};

/**
 * Verifies the signature of the webhook payload.
 * This is a simple example using HMAC with SHA-256.
 * @param body - The raw request body string.
 * @param signature - The signature from the X-Signature header.
 * @param secret - The shared secret.
 * @returns A promise that resolves to true if the signature is valid.
 */
async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signatureBuffer = hexToBuffer(signature);
  const data = encoder.encode(body);

  return await crypto.subtle.verify('HMAC', key, signatureBuffer, data);
}

/**
 * A helper function to convert a hex string to an ArrayBuffer.
 * @param hex - The hex string to convert.
 * @returns An ArrayBuffer representation of the hex string.
 */
function hexToBuffer(hex: string): ArrayBuffer {
  const buffer = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    buffer[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return buffer.buffer;
}

/**
 * This is where you would put your business logic for handling the webhook.
 * For example, updating a database, sending an email, or calling another API.
 * @param payload - The parsed JSON payload from the webhook.
 */
async function processWebhook(payload: WebhookPayload) {
  console.log(`Processing event ${payload.eventId} of type ${payload.eventType}`);

  // Example: Add your custom logic here
  switch (payload.eventType) {
    case 'USER_CREATED':
      console.log(`A new user was created with ID: ${payload.data.userId}`);
      // await db.insertUser({ id: payload.data.userId });
      break;
    case 'ITEM_UPDATED':
      console.log(`Item ${payload.data.itemId} was updated.`);
      // await someOtherApi.updateItem(payload.data.itemId);
      break;
    default:
      console.log('Unknown event type received.');
  }

  console.log(`Finished processing event ${payload.eventId}.`);
}

/**
 * Define the environment variables the worker expects.
 * In a real project, you would set WEBHOOK_SECRET in your wrangler.toml or via the Cloudflare dashboard.
 */
interface Env {
  WEBHOOK_SECRET: string;
}
