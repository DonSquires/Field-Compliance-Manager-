import os, json, urllib.parse, urllib.request

url = os.getenv('SUPABASE_URL')
key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')

if not url or not key:
    print("Env vars missing")
    exit(1)

def query_supabase(params):
    q = urllib.parse.urlencode(params)
    endpoint = f"{url.rstrip('/')}/rest/v1/bob_messages?{q}"
    req = urllib.request.Request(endpoint, headers={
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Accept': 'application/json'
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception as e:
        print(f"Error for query {params}: {e}")
        return []

# Let's see if we can search for one to see if there is any result
res = query_supabase({
    "select": "id,content,created_at",
    "content": "ilike.*AdminShell.tsx*",
    "limit": "5"
})
print("Using * wildcard:", len(res))

res_pct = query_supabase({
    "select": "id,content,created_at",
    "content": "ilike.%AdminShell.tsx%",
    "limit": "5"
})
print("Using % wildcard:", len(res_pct))

