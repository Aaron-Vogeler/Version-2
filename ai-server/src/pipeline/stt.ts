import { createClient } from "@deepgram/sdk";
import config from "../config";

/**
 * Creates and returns a configured Deepgram client instance.
 * The client is ready for live transcription with the API key from config.
 */
export function createDeepgramClient() {
  return createClient(config.deepgram.apiKey);
}
