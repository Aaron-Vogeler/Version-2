#!/bin/bash

# Test webhook locally (without signature verification for testing)
# In production, Telnyx will send signed webhooks

WORKER_URL="http://localhost:8787"  # or your deployed worker URL
TENANT_ID="00000000-0000-0000-0000-000000000001"

echo "Sending call.initiated event..."
curl -X POST "$WORKER_URL/telnyx/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "event_type": "call.initiated",
      "id": "evt_test_'$(date +%s)'",
      "occurred_at": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'",
      "payload": {
        "call_control_id": "call_test_'$(date +%s)'",
        "direction": "outgoing",
        "from": "+14155551234",
        "to": "+14155555678",
        "state": "parked",
        "start_time": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'",
        "custom_headers": {
          "X-Tenant": "'$TENANT_ID'"
        },
        "client_state": "{\"tenant_id\":\"'$TENANT_ID'\",\"goal\":\"sales\"}"
      }
    }
  }'

echo ""
echo "Event sent! Check your dashboard."
