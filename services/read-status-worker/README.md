# Read status Worker

A tiny Cloudflare Worker for Warpmail's read status. Each email carries a 1×1 transparent image served from here; this Worker notes that it was fetched, and Warpmail asks for the notes every couple of minutes. It runs on your own Cloudflare account, on the free tier, and has no dependencies.

## What it stores

For each fetch of an image: a random code, the time, and a source type (`apple`, `google` or `other`). That is all.

It does **not** store IP addresses, names, email addresses, subjects or anything else. The visitor's address is read only at the moment of the fetch, to recognise Apple's and Google's published networks, and is then dropped. The Worker never logs. Records are deleted automatically after 90 days.

## Endpoints

- `GET /p/<code>.gif` returns the image (never cached) and records the fetch.
- `GET /records?since=<id>&limit=<n>` returns records after a cursor. It needs the header `Authorization: Bearer <PASSWORD>`.
- Anything else is a 404.

## Set it up

First choose a password. Make it on your own machine and keep it to yourself; you will type it into Cloudflare and into Warpmail's Settings, nowhere else.

```
openssl rand -base64 32
```

You need a free Cloudflare account. Pick one of the two paths.

### A. In the Cloudflare dashboard

1. Go to **Storage & Databases → D1 SQL database**, choose **Create database**, and name it `read-status`.
2. Go to **Workers & Pages → Create → Create Worker**. Name it `read-status` and deploy the starter code.
3. Choose **Edit code**. Replace the code with the contents of `src/index.js`, and add two more files named `classify.js` and `ranges.js` with the contents of the files of the same name from `src/`. Deploy. (Uploading the `src/` folder works too.)
4. Open the Worker's **Settings → Bindings → Add → D1 database**. Set the variable name to `DB` and choose `read-status`.
5. In **Settings → Variables and Secrets**, add a **Secret** named `PASSWORD` with your password.
6. In **Settings → Trigger Events → Cron Triggers**, add the cron `17 3 * * *`. This runs the daily clean-up.

### B. From the command line

Run these in this folder (`services/read-status-worker`). They use `npx wrangler@4`, so nothing is installed.

1. `npx wrangler@4 login`
2. `npx wrangler@4 d1 create read-status` prints a `database_id`.
3. Put that id in `wrangler.toml` on your machine, replacing `REPLACE_WITH_YOUR_DATABASE_ID`. **Do not commit this change.**
4. `npx wrangler@4 secret put PASSWORD` asks for the password on the terminal.
5. `npx wrangler@4 deploy`

The table is created by the Worker itself on first use.

### Your own address (recommended)

The default `https://read-status.<your-subdomain>.workers.dev` address works. A name on your own domain, for example `t.example.com`, is better because spam filters trust it more. Open the Worker's **Settings → Domains & Routes → Add → Custom domain** and enter it. The domain must be on your Cloudflare account.

## Check that it works

```
curl -I https://t.example.com/p/TESTTESTTESTTESTTEST.gif
```

You should see `200` and `content-type: image/gif`. A `HEAD` request records nothing; to record a test fetch use `curl -s -o /dev/null https://t.example.com/p/TESTTESTTESTTESTTEST.gif`.

Then, using your own password:

```
curl -H "Authorization: Bearer <your password>" "https://t.example.com/records?since=0"
```

You should get `{"records":[...],"next":...}`. A wrong password gives `401`; if the `PASSWORD` secret is missing you get `500`.

In Warpmail, enter the address and password in **Settings → Read status**.

## Run it locally

1. Create `.dev.vars` in this folder (it is git-ignored) with a line such as `PASSWORD=test-password`.
2. `npx wrangler@4 dev`

Local runs use a local D1 copy. Open the address it prints.

## Refreshing the network ranges

`src/ranges.js` holds Apple's and Google's ranges. Apple's are kept by hand, with their source in a comment. Google's can be refreshed from its published list:

```
node scripts/update-ranges.mjs
```

It rewrites only the Google block. Then redeploy.

## Tests

The tests live in the repo's root `tests/` folder: `corepack pnpm exec vitest run tests/read-status-worker.test.ts`.
