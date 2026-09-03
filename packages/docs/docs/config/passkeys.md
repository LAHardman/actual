# Authenticating with Passkeys

:::info
This feature requires use of [Actual Server](./index.md).
:::

:::caution
Passkey support is in preview. Keep the server password somewhere safe: it remains the way back in if every passkey is lost, and it is what you use to create the very first one.
:::

A passkey lets you sign in with your fingerprint, your face, or a security key instead of a password. Each passkey is a private key that never leaves your device, so there is nothing to phish and nothing to reuse across sites.

Enabling passkeys on your server also unlocks [multi-user support](./multi-user.md): every person who signs in with a passkey is a named user with their own role and their own access to budget files. Unlike [OpenID](./oauth-auth.md), passkeys need no identity provider. The sync server handles everything itself.

## Before You Start

Passkeys are bound to the address of your server, and browsers only allow them over `https://`. Make sure of two things first:

- Everyone reaches the server at the **same address**, for example `https://budget.example.com`. That address becomes the relying party ID every passkey is tied to.
- The address is served with a valid certificate. `http://localhost` is the only exception, for testing on the machine the server runs on.

:::warning
Do not change the server address once people have created passkeys. Passkeys are tied to it, and a new address makes every existing passkey unusable. If you must move the server, plan to re-enrol everyone, and keep the server password available in the meantime.
:::

## Enabling Passkeys

Open any budget, go to **Settings**, and under **Authentication method** click **Start using passkeys**.

The dialog shows the server address it will use and lets you choose the name your device shows when it asks you to create a passkey. Click **OK**. Every session is closed and you are taken back to the sign-in screen.

## Creating the First Passkey

The first passkey creates the **server owner**, so it is guarded by the server password. On the sign-in screen:

1. Enter the server password.
2. Enter the username you want, and optionally a display name.
3. Click **Create the first passkey**. Your device asks for your fingerprint, face, PIN or security key.

You are signed in, and you are now the owner and an admin. This cannot be changed from the app afterwards.

## Signing In

The sign-in screen has a single **Sign in with a passkey** button. There is no username field: your device shows its own list of accounts for this server and asks you to confirm with your fingerprint, face, PIN or security key.

If you have more than one login method available, the **Select the login method** link below the button lets you switch between them.

## Adding People

Other people join through an **invitation link**. As an admin:

1. Open **User Directory** from the menu and add the person as you would for OpenID, with the username they will use.
2. Click **Invite** on their row. A link is copied to your clipboard.
3. Send them the link. They open it on the device they want to sign in from, optionally name the device, and click **Create passkey and sign in**.

Each link works once and expires after a day. If it expires, click **Invite** again for a new one.

## Managing Your Passkeys

Under **Settings → Authentication method**, click **Manage passkeys** to see every passkey on your account: its name, whether it is synced between your devices or lives on one device only, and when it was last used. From there you can:

- **Add this device**, so you can sign in from a second phone or computer.
- **Rename** a passkey so you can tell them apart.
- **Remove** one you no longer use.

You cannot remove your own last passkey while passkeys are the login method, so you cannot lock yourself out by tidying up. An admin can remove another person's last passkey, so a lost phone can be replaced with a fresh invitation.

## Disabling Passkeys

Click **Disable passkeys** under the authentication setting and type the server password. Every named user, their file access and every passkey is removed, all sessions are closed, and the server goes back to the single shared password. Budget files are kept.

## Configuration Without the App

The same settings are available as environment variables, which also enable passkeys when the server starts:

- `ACTUAL_PASSKEY_SERVER_HOSTNAME`: the public URL of your server, for example `https://budget.example.com`.
- `ACTUAL_PASSKEY_RP_NAME`: the name your device shows when it asks you to create a passkey. Defaults to `Actual Budget`.
- `ACTUAL_PASSKEY_EXTRA_ORIGINS`: optional, comma separated. Additional origins that are allowed to complete a passkey ceremony, such as a native mobile app. Most people will not need this.
- `ACTUAL_PASSKEY_ENFORCE`: set to `true` to hide every other login method once passkeys are working. Leave it unset until you have signed in with a passkey successfully.

The same settings can go in `config.json` under a `passkey` key, using `server_hostname`, `rpName`, `extraOrigins` and `enforce`.

`ACTUAL_TOKEN_EXPIRATION` applies to passkey sessions as it does to password sessions: `never` (the default) or a number of seconds.

## Which Devices Can Use Passkeys

Passkeys work in current versions of Firefox, Chrome, Edge and Safari, on phones and desktops, whenever the site is served over `https://`.

They do not work inside every app that embeds a web view. In particular, an Android app that embeds a browser engine cannot create or use passkeys for a website unless Android recognises it as a browser, so a custom wrapper app will fail where Firefox for Android on the same phone succeeds. The desktop app may also be unable to use passkeys on some platforms; sign in through a browser there, or keep another login method available.
