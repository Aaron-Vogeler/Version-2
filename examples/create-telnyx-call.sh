#!/bin/bash

# Sample script to create a Telnyx outbound call with tenant_id and goal tracking
# Replace variables with your actual values

TELNYX_API_KEY="YOUR_TELNYX_API_KEY"
CONNECTION_ID="YOUR_CONNECTION_ID"
TENANT_ID="00000000-0000-0000-0000-000000000001"
FROM_NUMBER="+14155551234"
TO_NUMBER="+14155555678"
GOAL="sales"

curl -X POST https://api.telnyx.com/v2/calls \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"connection_id\": \"$CONNECTION_ID\",
    \"to\": \"$TO_NUMBER\",
    \"from\": \"$FROM_NUMBER\",
    \"custom_headers\": [
      {
        \"name\": \"X-Tenant\",
        \"value\": \"$TENANT_ID\"
      }
    ],
    \"client_state\": \"{\\\"tenant_id\\\":\\\"$TENANT_ID\\\",\\\"goal\\\":\\\"$GOAL\\\"}\"
  }"

echo ""
echo "Call created! Check your dashboard for real-time updates."
