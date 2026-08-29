import os
import json
import urllib.parse
import urllib.request

url = os.environ.get('SUPABASE_URL')
key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')

if not url or not key:
    print("Env vars missing")
    exit(1)

filenames = [
    "AdminShell.tsx",
    "OfficerShell.tsx",
    "DispatchConsolePage.tsx",
    "AdminHubPage.tsx",
    "WelfareAlertsPage.tsx"
]

all_messages = {}

for filename in filenames:
    # Use percent for standard SQL like in PostgREST
    params = {
        'select': 'id,content,created_at',
        'content': f'ilike.%{filename}%',
        'order': 'created_at.asc',
        'limit': '500'
    }
    q = urllib.parse.urlencode(params)
    endpoint = f"{url.rstrip('/')}/rest/v1/bob_messages?{q}"
    req = urllib.request.Request(endpoint, headers={
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Accept': 'application/json'
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode('utf-8')
            messages = json.loads(body)
            # Add to map to deduplicate by id
            for msg in messages:
                all_messages[msg['id']] = msg
            print(f"File '{filename}' matched {len(messages)} messages.")
    except Exception as e:
        print(f"Error querying {filename}: {e}")

# Now order all deduplicated messages by created_at ASC
sorted_messages = sorted(all_messages.values(), key=lambda x: x['created_at'])

print(f"\nTotal unique messages found: {len(sorted_messages)}\n")

for i, msg in enumerate(sorted_messages, 1):
    print(f"=== MESSAGE {i} ===")
    print(f"ID: {msg.get('id')}")
    print(f"Created At: {msg.get('created_at')}")
    print("--- CONTENT START ---")
    print(msg.get('content'))
    print("--- CONTENT END ---\n")

