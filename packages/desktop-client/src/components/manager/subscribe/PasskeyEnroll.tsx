import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { ButtonWithLoading } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { ResponsiveInput } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Link } from '#components/common/Link';
import { useSetServerURL } from '#components/ServerContext';
import { useNavigate } from '#hooks/useNavigate';
import { useDispatch } from '#redux';
import { loggedIn } from '#users/usersSlice';
import { getPasskeyErrors } from '#util/error';
import { createPasskey, passkeysSupported } from '#util/passkeys';

import { Title } from './common';

/**
 * Landing page for an enrolment link an admin generated in the User Directory.
 * Opened on a fresh device, so the server URL may not be set yet: this page
 * points loot-core at its own origin before doing anything else, the same way
 * the login page does on a first visit.
 */
export function PasskeyEnroll() {
  const { t } = useTranslation();
  const { isNarrowWidth } = useResponsive();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const setServerURL = useSetServerURL();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;
    async function prepare() {
      const url = await send('get-server-url');
      if (!url) {
        await setServerURL(window.location.origin, { validate: false });
      }
      if (!isCancelled) {
        setReady(true);
      }
    }
    void prepare();
    return () => {
      isCancelled = true;
    };
  }, [setServerURL]);

  async function onEnrol() {
    if (!token || loading) return;
    setError(null);
    setLoading(true);
    try {
      const options = await send('passkey-register-options', {
        enrolmentToken: token,
      });
      if ('error' in options) {
        setError(options.error);
        return;
      }

      const ceremony = await createPasskey(options.options);
      if ('error' in ceremony) {
        setError(ceremony.error);
        return;
      }

      const verified = await send('passkey-register-verify', {
        enrolmentToken: token,
        challengeId: options.challengeId,
        response: ceremony.response,
        name: deviceName.trim() || undefined,
      });
      if (verified.error) {
        setError(verified.error);
        return;
      }

      await dispatch(loggedIn());
      void navigate('/');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={{ maxWidth: 450, marginTop: -30, color: theme.pageText }}>
      <Title text={t('Create your passkey')} />

      {!token && (
        <Text style={{ color: theme.errorText }}>
          <Trans>
            This link is missing its invitation code. Ask the person who sent it
            for a new one.
          </Trans>
        </Text>
      )}

      {token && !passkeysSupported() && (
        <Text style={{ color: theme.warningText, lineHeight: 1.4 }}>
          <Trans>
            This browser cannot create passkeys. Open the link in a current
            version of Firefox, Chrome, Edge or Safari on the device you want to
            sign in from.
          </Trans>
        </Text>
      )}

      {token && passkeysSupported() && (
        <View style={{ gap: 12 }}>
          <Text style={{ fontSize: 16, lineHeight: 1.4 }}>
            <Trans>
              You have been invited to this Actual server. Create a passkey on
              this device and you will be signed in straight away. Your device
              will ask for your fingerprint, face, PIN or security key.
            </Trans>
          </Text>

          <ResponsiveInput
            type="text"
            placeholder={t("Name this device (optional), e.g. Laura's phone")}
            value={deviceName}
            onChangeValue={setDeviceName}
            onEnter={onEnrol}
          />

          <ButtonWithLoading
            variant="primary"
            isLoading={loading}
            isDisabled={!ready}
            onPress={onEnrol}
            style={{
              fontSize: 15,
              padding: isNarrowWidth ? 10 : undefined,
              alignSelf: isNarrowWidth ? 'stretch' : 'flex-end',
              minWidth: 220,
            }}
          >
            <Trans>Create passkey and sign in</Trans>
          </ButtonWithLoading>

          <Text style={{ fontSize: 13, color: theme.pageTextLight }}>
            <Trans>
              Each invitation works once and expires after a day. Already have a
              passkey here?{' '}
              <Link variant="internal" to="/login">
                Sign in instead
              </Link>
              .
            </Trans>
          </Text>
        </View>
      )}

      {error && (
        <Text style={{ marginTop: 20, color: theme.errorText, fontSize: 15 }}>
          {getPasskeyErrors(error) ??
            t('An unknown error occurred: {{error}}', { error })}
        </Text>
      )}
    </View>
  );
}
