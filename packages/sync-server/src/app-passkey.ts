import express from 'express';
import type { Request, Response } from 'express';

import { disablePasskey, enablePasskey, isAdmin } from './account-db';
import type { RegistrationRequest } from './accounts/passkey';
import {
  createAuthenticationOptions,
  createEnrolmentToken,
  createRegistrationOptions,
  deleteCredential,
  getPasskeyServerHostname,
  listCredentials,
  renameCredential,
  verifyAuthentication,
  verifyRegistration,
} from './accounts/passkey';
import { authRateLimiter } from './app-account';
import {
  errorMiddleware,
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from './util/middlewares';
import { validateSession } from './util/validate-user';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLoggerMiddleware);

export { app as handlers };

function forbidden(res: Response) {
  res.status(403).send({
    status: 'error',
    reason: 'forbidden',
    details: 'permission-not-found',
  });
}

// ------------------------------------------------------- enable and disable

app.post('/enable', validateSessionMiddleware, async (req, res) => {
  if (!isAdmin(res.locals.user_id)) {
    forbidden(res);
    return;
  }

  const { error } = (await enablePasskey(req.body)) || {};
  if (error) {
    res.status(400).send({ status: 'error', reason: error });
    return;
  }
  res.send({ status: 'ok' });
});

app.post('/disable', validateSessionMiddleware, async (req, res) => {
  if (!isAdmin(res.locals.user_id)) {
    forbidden(res);
    return;
  }

  const { error } = (await disablePasskey(req.body)) || {};
  if (error) {
    res.status(401).send({ status: 'error', reason: error });
    return;
  }
  res.send({ status: 'ok' });
});

// ------------------------------------------------------------ registration
//
// Who is registering is decided by what the request carries, in this order:
// an enrolment token (someone an admin invited), the server password (the
// very first passkey, which creates the owner), or a session (an existing
// user adding another device).

function registrationRequestFrom(
  req: Request,
  res: Response,
): RegistrationRequest | null {
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (typeof body.enrolmentToken === 'string') {
    return { mode: 'enrolment', token: body.enrolmentToken };
  }

  if (typeof body.password === 'string') {
    return {
      mode: 'bootstrap',
      password: body.password,
      userName: typeof body.userName === 'string' ? body.userName : '',
      displayName:
        typeof body.displayName === 'string' ? body.displayName : undefined,
    };
  }

  const session = validateSession(req, res);
  if (!session) {
    return null;
  }
  return { mode: 'session', userId: session.user_id };
}

app.post('/register/options', authRateLimiter, async (req, res) => {
  const request = registrationRequestFrom(req, res);
  if (!request) {
    return;
  }

  const result = await createRegistrationOptions(request);
  if ('error' in result) {
    res.status(400).send({ status: 'error', reason: result.error });
    return;
  }
  res.send({ status: 'ok', data: result });
});

app.post('/register/verify', authRateLimiter, async (req, res) => {
  const request = registrationRequestFrom(req, res);
  if (!request) {
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (
    typeof body.challengeId !== 'string' ||
    typeof body.response !== 'object'
  ) {
    res.status(400).send({ status: 'error', reason: 'invalid-request' });
    return;
  }

  const result = await verifyRegistration({
    request,
    challengeId: body.challengeId,
    response: body.response as Parameters<
      typeof verifyRegistration
    >[0]['response'],
    name: typeof body.name === 'string' ? body.name : undefined,
  });
  if ('error' in result) {
    res.status(400).send({ status: 'error', reason: result.error });
    return;
  }
  res.send({ status: 'ok', data: result });
});

// ----------------------------------------------------------------- sign in

app.post('/login/options', authRateLimiter, async (req, res) => {
  const result = await createAuthenticationOptions();
  if ('error' in result) {
    res.status(400).send({ status: 'error', reason: result.error });
    return;
  }
  res.send({ status: 'ok', data: result });
});

app.post('/login/verify', authRateLimiter, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (
    typeof body.challengeId !== 'string' ||
    typeof body.response !== 'object'
  ) {
    res.status(400).send({ status: 'error', reason: 'invalid-request' });
    return;
  }

  const result = await verifyAuthentication({
    challengeId: body.challengeId,
    response: body.response as Parameters<
      typeof verifyAuthentication
    >[0]['response'],
  });
  if ('error' in result) {
    res.status(400).send({ status: 'error', reason: result.error });
    return;
  }
  res.send({ status: 'ok', data: result });
});

// ---------------------------------------------------------------- invites

app.post('/invite', validateSessionMiddleware, (req, res) => {
  if (!isAdmin(res.locals.user_id)) {
    forbidden(res);
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.userId !== 'string') {
    res.status(400).send({ status: 'error', reason: 'user-cant-be-empty' });
    return;
  }

  const result = createEnrolmentToken(body.userId);
  if ('error' in result) {
    res.status(400).send({ status: 'error', reason: result.error });
    return;
  }

  const serverHostname = getPasskeyServerHostname();
  const url = serverHostname
    ? new URL(
        `/passkey-enroll?token=${result.token}`,
        serverHostname,
      ).toString()
    : null;

  res.send({ status: 'ok', data: { ...result, url } });
});

// ------------------------------------------------------------- management

app.get('/credentials', validateSessionMiddleware, (req, res) => {
  const requested = req.query.userId;
  const requesterId = res.locals.user_id as string;

  let userId = requesterId;
  if (typeof requested === 'string' && requested !== requesterId) {
    if (!isAdmin(requesterId)) {
      forbidden(res);
      return;
    }
    userId = requested;
  }

  res.send({ status: 'ok', data: listCredentials(userId) });
});

app.patch('/credentials/:id', validateSessionMiddleware, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.name !== 'string') {
    res.status(400).send({ status: 'error', reason: 'invalid-request' });
    return;
  }

  const requesterId = res.locals.user_id as string;
  const result = renameCredential({
    credentialId: req.params.id,
    name: body.name,
    requesterId,
    isAdmin: isAdmin(requesterId),
  });
  if ('error' in result) {
    res
      .status(result.error === 'forbidden' ? 403 : 400)
      .send({ status: 'error', reason: result.error });
    return;
  }
  res.send({ status: 'ok' });
});

app.delete('/credentials/:id', validateSessionMiddleware, (req, res) => {
  const requesterId = res.locals.user_id as string;
  const result = deleteCredential({
    credentialId: req.params.id,
    requesterId,
    isAdmin: isAdmin(requesterId),
  });
  if ('error' in result) {
    res
      .status(result.error === 'forbidden' ? 403 : 400)
      .send({ status: 'error', reason: result.error });
    return;
  }
  res.send({ status: 'ok' });
});

app.use(errorMiddleware);
