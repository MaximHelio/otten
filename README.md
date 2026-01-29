![alt text](/public/qrcode.png)

## Request → Response Flow

```text
User Question
   ↓
HTML/JS
   ↓
Cloudflare Worker
   ├─ embed query
   ├─ vector search (KV)
   ├─ retrieve docs
   └─ compose prompt
   ↓
Groq API → LLM
   ↓
Response
