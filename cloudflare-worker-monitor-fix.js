/**
 * Telnyx Voice API → Supabase Call Logger
 * Cloudflare Worker - WITH MONITOR LEG FIXES
 *
 * Features:
 * - Outbound call initiation with user tracking
 * - Webhook handling for call events
 * - Real-time + post-call transcription logging
 * - Cost tracking
 * - Multi-user support via user_id (NOT NULL)
 * - Conference + monitor leg for live listening (FIXED)
 *
 * Environment Variables:
 * - TELNYX_API_KEY
 * - FROM_NUMBER
 * - MONITOR_NUMBER        (DID used by WebRTC monitor leg – can be same as FROM_NUMBER)
 * - CALL_CONTROL_APP_ID
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_KEY  (service_role)
 * - DEFAULT_USER_ID       (RECOMMENDED: your auth.users.id)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ============================================================================
    // UTILITY FUNCTIONS
    // ============================================================================

    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };

    const now = () => new Date().toISOString();

    const cleanObject = (obj) =>
      Object.fromEntries(
        Object.entries(obj).filter(([_, v]) => v !== null && v !== undefined)
      );

    const normalizeDirection = (direction) => {
      const normalized = direction?.toString().toLowerCase();
      return normalized === "inbound" ? "inbound" : "outbound";
    };

    const getUserIdFromJWT = (request) => {
      const authHeader = request.headers.get("Authorization") || "";
      const match = authHeader.match(/^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i);

      if (!match) return null;

      try {
        const token = match[1];
        const base64Payload = token.split(".")[1];
        const payload = JSON.parse(
          atob(base64Payload.replace(/-/g, "+").replace(/_/g, "/"))
        );
        return payload?.sub || null;
      } catch (error) {
        console.error("Failed to decode JWT:", error);
        return null;
      }
    };

    const extractTranscriptText = (payload) => {
      if (!payload) return null;

      if (payload.transcription_text) return payload.transcription_text;

      if (payload.transcription_data?.transcript) {
        return payload.transcription_data.transcript;
      }

      return (
        payload.transcript ||
        payload.text ||
        payload.final_transcript ||
        payload.results?.[0]?.alternatives?.[0]?.transcript ||
        payload.data?.transcript ||
        null
      );
    };

    const decodeClientState = (encodedState) => {
      if (!encodedState) return {};
      try {
        // Handle both stringified JSON and base64 encoded JSON
        if (typeof encodedState === 'string') {
          // Check if it looks like JSON or Base64
          if (encodedState.trim().startsWith('{')) {
             return JSON.parse(encodedState);
          }
          return JSON.parse(atob(encodedState));
        }
        return encodedState;
      } catch (error) {
        console.error("Failed to decode client_state:", error);
        return {};
      }
    };

    // ============================================================================
    // SUPABASE HELPERS
    // ============================================================================

    const supabaseHeaders = {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    const logSupabaseError = async (operation, response) => {
      const text = await response.text().catch(() => "Unable to read error");
      console.error(`Supabase ${operation} failed [${response.status}]:`, text);
    };

    const upsertCall = async (callData) => {
      if (!callData?.id) {
        console.error("Cannot upsert call without id");
        return;
      }
      if (!callData.user_id) {
        console.error(
          "Refusing to upsert call without user_id (user_id is NOT NULL)"
        );
        return;
      }

      const cleanData = cleanObject(callData);

      const response = await fetch(
        `${env.SUPABASE_URL}/rest/v1/calls?on_conflict=id`,
        {
          method: "POST",
          headers: {
            ...supabaseHeaders,
            Prefer: "resolution=merge-duplicates,return=representation",
          },
          body: JSON.stringify([cleanData]),
        }
      );

      if (!response.ok) {
        await logSupabaseError("upsert call", response);
      }

      return response;
    };

    const updateCall = async (callId, fields) => {
      if (!callId) {
        console.error("Cannot update call without id");
        return;
      }

      const data = cleanObject({
        ...fields,
        updated_at: now(),
      });

      const response = await fetch(
        `${env.SUPABASE_URL}/rest/v1/calls?id=eq.${encodeURIComponent(
          callId
        )}`,
        {
          method: "PATCH",
          headers: {
            ...supabaseHeaders,
            Prefer: "return=representation",
          },
          body: JSON.stringify(data),
        }
      );

      if (!response.ok) {
        await logSupabaseError("update call", response);
      }

      return response;
    };

    const appendTranscript = async (callId, newChunk, status) => {
      if (!callId || !newChunk) return;

      try {
        const getResponse = await fetch(
          `${env.SUPABASE_URL}/rest/v1/calls?id=eq.${encodeURIComponent(
            callId
          )}&select=live_transcript`,
          { headers: supabaseHeaders }
        );

        let existingTranscript = "";

        if (getResponse.ok) {
          const rows = await getResponse.json();
          if (Array.isArray(rows) && rows.length > 0) {
            existingTranscript = rows[0].live_transcript || "";
          }
        }

        const updatedTranscript = existingTranscript
          ? `${existingTranscript}\n${newChunk}`
          : newChunk;

        await updateCall(callId, {
          live_transcript: updatedTranscript,
          transcript_status: status,
        });
      } catch (error) {
        console.error("Failed to append transcript:", error);
      }
    };

    /**
     * FIXED: Fetch the conference ID for a SPECIFIC call.
     */
    const getConferenceIdForCall = async (targetCallId) => {
      if (!targetCallId) return null;

      try {
        const resp = await fetch(
          `${env.SUPABASE_URL}/rest/v1/calls` +
            `?select=conference_id` +
            `&id=eq.${encodeURIComponent(targetCallId)}` +
            `&limit=1`,
          { headers: supabaseHeaders }
        );

        if (!resp.ok) {
          await logSupabaseError("get conference for call", resp);
          return null;
        }

        const rows = await resp.json();
        if (Array.isArray(rows) && rows.length > 0) {
          return rows[0].conference_id || null;
        }
      } catch (error) {
        console.error("Failed to get conference for call:", error);
      }
      return null;
    };

    // ============================================================================
    // TELNYX HELPERS
    // ============================================================================

    const telnyxHeaders = {
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    };

    const startRecording = async (callControlId) => {
      return fetch(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/record_start`,
        {
          method: "POST",
          headers: telnyxHeaders,
          body: JSON.stringify({
            format: "mp3",
            channels: "dual",
          }),
        }
      ).catch((error) => {
        console.error("Failed to start recording:", error);
      });
    };

    const startTranscription = async (callControlId) => {
      return fetch(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/transcription_start`,
        {
          method: "POST",
          headers: telnyxHeaders,
          body: JSON.stringify({
            language: "en",
            transcription_engine: "telnyx",
            transcription_tracks: "both",
          }),
        }
      ).catch((error) => {
        console.error("Failed to start transcription:", error);
      });
    };

    // Create a conference for the primary call leg
    const createConference = async (callControlId, name) => {
      if (!callControlId) {
        console.error("Cannot create conference without call_control_id");
        return null;
      }

      try {
        const resp = await fetch("https://api.telnyx.com/v2/conferences", {
          method: "POST",
          headers: telnyxHeaders,
          body: JSON.stringify({
            call_control_id: callControlId,
            name,
          }),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => "Unable to read error");
          console.error(
            `Telnyx createConference failed [${resp.status}]:`,
            text
          );
          return null;
        }

        const data = await resp.json().catch(() => null);
        return data?.data || null;
      } catch (error) {
        console.error("Failed to create conference:", error);
        return null;
      }
    };

    // Join an existing conference as a monitor
    const joinConferenceAsMonitor = async (conferenceId, callControlId) => {
      if (!conferenceId || !callControlId) {
        console.error(
          "Cannot join conference as monitor without conference_id and call_control_id"
        );
        return;
      }

      try {
        const resp = await fetch(
          `https://api.telnyx.com/v2/conferences/${conferenceId}/actions/join`,
          {
            method: "POST",
            headers: telnyxHeaders,
            body: JSON.stringify({
              call_control_id: callControlId,
              supervisor_role: "monitor",
            }),
          }
        );

        if (!resp.ok) {
          const text = await resp.text().catch(() => "Unable to read error");
          console.error(
            `Telnyx joinConferenceAsMonitor failed [${resp.status}]:`,
            text
          );
        }
      } catch (error) {
        console.error("Failed to join conference as monitor:", error);
      }
    };

    // ============================================================================
    // ROUTE: HEALTH CHECK
    // ============================================================================

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("✅ Telnyx Voice API Worker - Online", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // ============================================================================
    // ROUTE: START OUTBOUND CALL
    // ============================================================================

    if (url.pathname === "/start-call" && request.method === "POST") {
      try {
        const body = await request.json();
        const { to_number, goal } = body;

        if (!to_number) {
          return jsonResponse(
            { error: "Missing required field: to_number" },
            400
          );
        }

        // Resolve user_id (REQUIRED because calls.user_id is NOT NULL)
        const userIdFromBody = body.user_id;
        const userIdFromJWT = getUserIdFromJWT(request);
        const fallbackUserId = env.DEFAULT_USER_ID || null;
        const userId = userIdFromBody || userIdFromJWT || fallbackUserId;

        if (!userId) {
          console.error(
            "No user_id found (body, JWT, DEFAULT_USER_ID). Cannot log call."
          );
          return jsonResponse(
            {
              error:
                "Missing user_id. Pass user_id in body OR set DEFAULT_USER_ID in Cloudflare env.",
            },
            400
          );
        }

        // Encode metadata in client_state
        const clientState = btoa(
          JSON.stringify({
            user_id: userId,
            goal: goal || null,
            to_number,
          })
        );

        const webhookUrl = new URL("/webhooks/telnyx", request.url).toString();

        console.log("🚀 Initiating call:", { to_number, goal, user_id: userId });

        const response = await fetch("https://api.telnyx.com/v2/calls", {
          method: "POST",
          headers: {
            ...telnyxHeaders,
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            to: to_number,
            from: env.FROM_NUMBER,
            connection_id: env.CALL_CONTROL_APP_ID,
            webhook_url: webhookUrl,
            answering_machine_detection: "premium",
            client_state: clientState,
          }),
        });

        const data = await response.json();

        const callSessionId =
          data?.data?.call_session_id ||
          data?.data?.call_session?.id ||
          data?.data?.call_control_id;

        if (callSessionId) {
          const timestamp = now();

          await upsertCall({
            id: callSessionId,
            user_id: userId,
            direction: "outbound",
            from_e164: env.FROM_NUMBER,
            to_e164: to_number,
            status: "initiated",
            goal: goal || null,
            created_at: timestamp,
            updated_at: timestamp,
            started_at: timestamp,
          });

          console.log("✅ Call initiated:", callSessionId);
        }

        return jsonResponse(data, response.status);
      } catch (error) {
        console.error("❌ Error starting call:", error);
        return jsonResponse(
          { error: error.message || "Failed to start call" },
          500
        );
      }
    }

    // ============================================================================
    // ROUTE: TELNYX WEBHOOKS
    // ============================================================================

    if (url.pathname === "/webhooks/telnyx" && request.method === "POST") {
      let event;

      try {
        event = await request.json();
      } catch (error) {
        console.error("Failed to parse webhook JSON:", error);
        return new Response("Invalid JSON", { status: 400 });
      }

      const eventType = event?.data?.event_type || "unknown";
      const payload = event?.data?.payload || {};

      const callControlId = payload.call_control_id;
      const callSessionId = payload.call_session_id || payload.call_session?.id;
      const callId = callSessionId || callControlId;

      if (!callId) {
        console.warn("Webhook received without call identifier:", eventType);
        return new Response("ok", { status: 200 });
      }

      const occurredAt =
        payload.occurred_at ||
        payload.timestamp ||
        payload.start_time ||
        now();

      const userVariables = payload.user_variables || {};
      const monitorNumber = env.MONITOR_NUMBER;

      // Detect if this is the "Monitor" leg (the call from the browser)
      const isMonitorCall =
        !!monitorNumber &&
        (payload.to === monitorNumber || payload.to_number === monitorNumber);

      console.log("📞 Webhook received:", {
        type: eventType,
        callId,
        callControlId,
        to: payload.to || payload.to_number,
        from: payload.from || payload.from_number,
        isMonitorCall,
      });

      const clientStateData = decodeClientState(payload.client_state);
      const userId = clientStateData.user_id || env.DEFAULT_USER_ID || null;
      const goal = clientStateData.goal || null;

      // Extract phone numbers (required for database)
      const fromNumber = payload.from || payload.from_number;
      const toNumber = payload.to || payload.to_number;

      // FIXED: Skip upsert for monitor calls (they have invalid user_id 'admin_listener')
      // Also skip if we don't have required fields (from_e164, to_e164)
      if (userId && !isMonitorCall && fromNumber && toNumber) {
        await upsertCall({
          id: callId,
          user_id: userId,
          direction: normalizeDirection(payload.direction),
          from_e164: fromNumber,
          to_e164: toNumber,
          status: "initiated",
          goal: goal,
          created_at: occurredAt,
          updated_at: occurredAt,
          started_at: payload.start_time || occurredAt,
        });
      } else if (!isMonitorCall) {
        // Log why we're skipping
        const reasons = [];
        if (!userId) reasons.push('no user_id');
        if (!fromNumber) reasons.push('no from_number');
        if (!toNumber) reasons.push('no to_number');

        if (reasons.length > 0) {
          console.warn(
            `Skipping baseline upsert for ${callId}: ${reasons.join(', ')}`
          );
        }
      }
      // Monitor calls intentionally skip upsert

      // ----------------------------------------------------------------------
      // CALL ANSWERED HANDLER
      // ----------------------------------------------------------------------
      if (eventType === "call.answered" && callControlId) {
        if (isMonitorCall) {
          // 🔥 FIXED MONITOR LEG LOGIC 🔥

          ctx.waitUntil(
            (async () => {
              try {
                // 1. Extract target ID from clientState
                const monitorClientState = decodeClientState(payload.client_state);
                const targetCallId = monitorClientState.target_call_id;

                if (!targetCallId) {
                  console.error("❌ Monitor call missing target_call_id in clientState");
                  return;
                }

                console.log("🎧 Monitor call answered. Target call ID:", targetCallId);

                // 2. Look up the target call's conference ID with retry logic
                let conferenceId = await getConferenceIdForCall(targetCallId);

                // First retry (conference might still be creating)
                if (!conferenceId) {
                  console.log("⏳ Conference not ready, retrying in 1s...");
                  await new Promise(r => setTimeout(r, 1000));
                  conferenceId = await getConferenceIdForCall(targetCallId);
                }

                // Second retry
                if (!conferenceId) {
                  console.log("⏳ Second retry in 1.5s...");
                  await new Promise(r => setTimeout(r, 1500));
                  conferenceId = await getConferenceIdForCall(targetCallId);
                }

                if (!conferenceId) {
                  console.error("❌ Monitor failed: No conference found for target call:", targetCallId);
                  return;
                }

                // 3. Join the conference
                console.log(`🎧 Joining monitor to conference: ${conferenceId}`);
                await joinConferenceAsMonitor(conferenceId, callControlId);

                // 4. FIXED: Update the TARGET call row (not the monitor call row!)
                console.log(`✅ Updating target call ${targetCallId} with monitor info`);
                await updateCall(targetCallId, {
                  monitor_initiated: true,
                  monitor_conference_id: conferenceId,
                });

                console.log("✅ Monitor successfully joined conference");

              } catch (error) {
                console.error("❌ Monitor leg handler failed:", error);
              }
            })()
          );
        } else {
          // Primary AI/customer leg – record, transcribe, and create conference
          console.log("📱 Call answered, starting recording + transcription + conference");

          ctx.waitUntil(startRecording(callControlId));
          ctx.waitUntil(startTranscription(callControlId));

          ctx.waitUntil(
            updateCall(callId, {
              status: "answered",
              answered_at: now(),
            })
          );

          // Create a conference for this call
          ctx.waitUntil(
            (async () => {
              try {
                const existingConferenceId =
                  payload.conference_id || payload.conference?.id;

                if (existingConferenceId) {
                  await updateCall(callId, {
                    conference_id: existingConferenceId,
                  });
                  return;
                }

                console.log("🎧 Creating conference for call:", callId);
                const conf = await createConference(callControlId, callId);
                const conferenceId = conf?.id;

                if (conferenceId) {
                  console.log("✅ Conference created:", {
                    callId,
                    conferenceId,
                  });

                  await updateCall(callId, {
                    conference_id: conferenceId,
                  });
                } else {
                  console.error("❌ Failed to create conference for call:", callId);
                }
              } catch (error) {
                console.error("Failed to create conference for answered call:", error);
              }
            })()
          );
        }
      }

      // CALL INITIATED / RINGING
      if (eventType === "call.initiated" || eventType === "call.ringing") {
        // 🔥 AUTO-ANSWER MONITOR CALLS 🔥
        if (isMonitorCall && callControlId && eventType === "call.initiated") {
          console.log("🎧 Monitor call initiated, auto-answering...");

          ctx.waitUntil(
            (async () => {
              try {
                const answerResp = await fetch(
                  `https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`,
                  {
                    method: "POST",
                    headers: telnyxHeaders,
                  }
                );

                if (answerResp.ok) {
                  console.log("✅ Monitor call auto-answered successfully");
                } else {
                  const errorText = await answerResp.text().catch(() => "Unable to read error");
                  console.error(
                    `❌ Failed to auto-answer monitor call [${answerResp.status}]:`,
                    errorText
                  );
                }
              } catch (error) {
                console.error("❌ Exception while auto-answering monitor call:", error);
              }
            })()
          );
        }

        // Update call status to ringing (for non-monitor calls)
        if (!isMonitorCall) {
          ctx.waitUntil(
            updateCall(callId, {
              status: "ringing",
            })
          );
        }
      }

      // CALL HANGUP
      if (eventType === "call.hangup") {
        const endedAt = now();
        const startTime = payload.start_time
          ? new Date(payload.start_time)
          : null;

        let durationSeconds = null;
        if (startTime) {
          durationSeconds = Math.max(
            0,
            Math.floor((new Date(endedAt) - startTime) / 1000)
          );
        }

        console.log("📴 Call ended:", {
          callId,
          duration: durationSeconds,
          cause: payload.hangup_cause,
        });

        ctx.waitUntil(
          updateCall(callId, {
            status: "completed",
            ended_at: endedAt,
            duration_sec: durationSeconds,
            billable_sec: durationSeconds,
          })
        );
      }

      // RECORDING SAVED
      if (eventType === "call.recording.saved") {
        const recordingUrl =
          payload.public_recording_urls?.mp3 ||
          payload.public_recording_urls?.wav ||
          payload.recording_urls?.mp3 ||
          payload.recording_urls?.wav ||
          payload.recording_url ||
          null;

        if (recordingUrl) {
          console.log("🎙️ Recording saved:", recordingUrl);

          ctx.waitUntil(
            updateCall(callId, {
              recording_url: recordingUrl,
            })
          );
        }
      }

      // LIVE TRANSCRIPTION
      const liveTranscriptionEvents = [
        "call.transcription",
        "call.transcription.partial",
        "call.transcription.updated",
        "ai.transcription.partial",
        "ai.transcription.final",
      ];

      if (liveTranscriptionEvents.includes(eventType)) {
        const transcriptText = extractTranscriptText(payload);

        if (transcriptText) {
          const isFinalFlag =
            payload.transcription_data?.is_final ?? payload.is_final ?? false;

          const isFinal =
            isFinalFlag === true ||
            isFinalFlag === "true" ||
            isFinalFlag === 1 ||
            eventType.includes("final");

          const status = isFinal ? "completed" : "in_progress";

          console.log("📝 Live transcript:", {
            type: eventType,
            length: transcriptText.length,
            isFinal,
          });

          ctx.waitUntil(appendTranscript(callId, transcriptText, status));
        }
      }

      // RECORDING TRANSCRIPTION SAVED
      if (eventType === "call.recording.transcription.saved") {
        const transcriptText = extractTranscriptText(payload);
        const transcriptionId = payload.recording_transcription_id;

        const transcriptionUrl = transcriptionId
          ? `/recording_transcriptions/${transcriptionId}`
          : payload.transcription_url || null;

        console.log("📄 Recording transcription saved:", {
          hasText: !!transcriptText,
          transcriptionId,
        });

        ctx.waitUntil(
          updateCall(callId, {
            live_transcript: transcriptText || undefined,
            transcript_status: "completed",
            transcription_url: transcriptionUrl || undefined,
          })
        );
      }

      // CALL COST
      if (eventType === "call.cost") {
        const billedSeconds =
          payload.billed_duration_secs ||
          payload.billed_duration_seconds ||
          null;

        const totalCost =
          payload.total_cost || payload.amount_billed_usd || null;

        const currency = payload.currency || "USD";

        console.log("💰 Call cost:", {
          billedSeconds,
          cost: totalCost,
          currency,
        });

        ctx.waitUntil(
          updateCall(callId, {
            billable_sec: billedSeconds,
            cost_usd: currency === "USD" ? totalCost : null,
          })
        );
      }

      // LEGACY BILLING (fallback)
      if (eventType === "call.billing.updated") {
        ctx.waitUntil(
          updateCall(callId, {
            cost_usd: payload.amount_billed_usd || null,
            billable_sec: payload.billable_duration_seconds || null,
          })
        );
      }

      return new Response("ok", { status: 200 });
    }

    // ============================================================================
    // ROUTE: DYNAMIC VARIABLES (for Telnyx AI Assistant)
    // ============================================================================

    if (url.pathname === "/dynamic-variables" && request.method === "POST") {
      try {
        const webhook = await request.json();
        const callControlId = webhook?.data?.payload?.call_control_id;

        if (!callControlId) {
          return jsonResponse({});
        }

        const response = await fetch(
          `https://api.telnyx.com/v2/calls/${callControlId}`,
          { headers: telnyxHeaders }
        );

        const callData = await response.json();
        const clientStateEncoded = callData?.data?.client_state;

        const variables = decodeClientState(clientStateEncoded);

        console.log("🔄 Dynamic variables requested:", variables);

        return jsonResponse({ dynamic_variables: variables });
      } catch (error) {
        console.error("Failed to fetch dynamic variables:", error);
        return jsonResponse({});
      }
    }

    // ============================================================================
    // 404 NOT FOUND
    // ============================================================================

    return new Response("Not Found", { status: 404 });
  },
};
