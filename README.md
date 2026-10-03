# Nimbo (phone-friendly, all files in one folder)

## Deploy from an Android phone
1. Extract the zip in the Files app.
2. GitHub (browser, switch Chrome to "Desktop site"): New repository > "uploading an existing file" > open the extracted folder, select ALL files > Commit. Never upload keys.
3. render.com > New > Web Service > connect the repo. Runtime Node, Build `npm install`, Start `npm start`, plan Free.
4. Environment variables (see env-example.txt): NODE_ENV=production, SECRET, BASE_URL, PAYSTACK_SECRET_KEY, ADMIN_KEY, WHATSAPP_NUMBER, GA_ID. Do NOT add DEV_PRO.
5. After the first deploy, copy your onrender.com address into BASE_URL and redeploy. Open /health (should say ok).
6. Add an UptimeRobot monitor on /health every 5 minutes so the free server stays awake.
7. Edit privacy.html and terms.html (replace YOUR_EMAIL@example.com and [DATE]).

## Notes
- Use Paystack TEST key first, then the LIVE key after your account is activated.
- /admin generates access codes for manual payments.
- Free-limit counts and used codes reset when the server restarts; add a database before heavy use.
