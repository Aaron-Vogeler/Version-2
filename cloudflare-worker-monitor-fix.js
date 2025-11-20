/**
 * FIXED MONITOR LEG LOGIC FOR CLOUDFLARE WORKER
 *
 * Replace the monitor leg section in your call.answered handler with this code.
 *
 * Key fixes:
 * 1. Don't upsert monitor call with invalid user_id
 * 2. Update BOTH monitor call AND target call in database
 * 3. Better error handling and logging
 */

// ========================================
// IN THE call.answered HANDLER:
// ========================================

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
            // Optionally hang up the monitor call here
            return;
          }

          console.log("🎧 Monitor call answered. Target call ID:", targetCallId);

          // 2. Look up the target call's conference ID
          let conferenceId = await getConferenceIdForCall(targetCallId);

          // Retry logic (conference might still be creating)
          if (!conferenceId) {
            console.log("⏳ Conference not ready, retrying in 1s...");
            await new Promise(r => setTimeout(r, 1000));
            conferenceId = await getConferenceIdForCall(targetCallId);
          }

          // Second retry if still not found
          if (!conferenceId) {
            console.log("⏳ Second retry in 1.5s...");
            await new Promise(r => setTimeout(r, 1500));
            conferenceId = await getConferenceIdForCall(targetCallId);
          }

          if (!conferenceId) {
            console.error("❌ Monitor failed: No conference found for target call:", targetCallId);
            // TODO: Optionally hang up the monitor call so user isn't stuck in silence
            return;
          }

          // 3. Join the conference
          console.log(`🎧 Joining monitor to conference: ${conferenceId}`);
          await joinConferenceAsMonitor(conferenceId, callControlId);

          // 4. Update the MONITOR call row (optional - you might not want to store this)
          // Skip the upsert because 'admin_listener' isn't a valid user_id
          // If you do want to log it, create a special 'monitor' user in auth.users first

          // 5. Update the TARGET/PRIMARY call row (THIS WAS MISSING!)
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


// ========================================
// ALSO UPDATE THE BASELINE UPSERT LOGIC:
// ========================================

// Before the switch/if statements for event handling, UPDATE this section:

const clientStateData = decodeClientState(payload.client_state);
const userId = clientStateData.user_id || env.DEFAULT_USER_ID || null;
const goal = clientStateData.goal || null;

// FIXED: Skip upsert for monitor calls (they have invalid user_id)
if (userId && !isMonitorCall) {
  await upsertCall({
    id: callId,
    user_id: userId,
    direction: normalizeDirection(payload.direction),
    from_e164: payload.from || payload.from_number,
    to_e164: payload.to || payload.to_number,
    status: "initiated",
    goal: goal,
    created_at: occurredAt,
    updated_at: occurredAt,
    started_at: payload.start_time || occurredAt,
  });
} else if (!userId && !isMonitorCall) {
  console.warn(
    "Webhook has no user_id and DEFAULT_USER_ID not set – skipping Supabase upsert for",
    callId
  );
}
// Monitor calls intentionally skip upsert (user_id is 'admin_listener', not a valid UUID)
