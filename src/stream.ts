/**
 * Converts an async generator into a readable stream.
 *
 * @param asyncGenerator - The async generator producing string data.
 * @returns A ReadableStream that streams the data produced by the generator.
 */
export const asyncGeneratorToStream = (
  asyncGenerator: AsyncGenerator<string, void, unknown>
) => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const value of asyncGenerator) {
          if (cancelled) {
            break;
          }

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ response: value })}\n\n`)
          );
        }

        // Send done to signal end of stream
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));

        controller.close();
      } catch (err) {
        console.log('Error in stream:', err);

        /* eslint-disable @stylistic/operator-linebreak */
        const errorMessage =
          err instanceof Error
            ? err.message
            : 'An error occurred in the stream';
        /* eslint-enable @stylistic/operator-linebreak */

        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({
              message: errorMessage,
            })}\n\n`
          )
        );

        controller.close();
      }
    },
    cancel(reason: any) {
      console.log('Client closed connection. Reason:', reason);
      cancelled = true;
    },
  });

  return stream;
};
