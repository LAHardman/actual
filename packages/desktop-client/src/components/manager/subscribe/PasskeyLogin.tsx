import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { ResponsiveInput } from '@actual-app/components/input';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { useAvailableLoginMethods } from '#components/ServerContext';
import { useDispatch } from '#redux';
import { loggedIn } from '#users/usersSlice';
import {
  authenticateWithPasskey,
  createPasskey,
  passkeysSupported,
} from '#util/passkeys';

type PasskeyLoginProps = {
  setError: (error: string | null) => void;
};

/**
 * Two screens share this component. When the server already has an owner it
 * is a single "Sign in with a passkey" button: the browser shows its own
 * account picker, so there is no username field. When no owner exists yet it
 * becomes the first-enrolment form, guarded by the server password exactly as
 * the first OpenID login is.
 */
export function PasskeyLogin({ setError }: PasskeyLoginProps) {
  const { t } = useTranslation();
  const { isNarrowWidth } = useResponsive();
  const dispatch = useDispatch();
  const loginMethods = useAvailableLoginMethods();

  const [ownerExists, setOwnerExists] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState('');
  const [userName, setUserName] = useState('');
  const [displayName, setDisplayName] = useState('');

  const supported = passkeysSupported();
  const passwordConfigured = loginMethods.some(m => m.method === 'password');

  useEffect(() => {
    void send('owner-created').then(created => setOwnerExists(created));
  }, []);

  async function onSignIn() {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const options = await send('passkey-login-options');
      if ('error' in options) {
        setError(options.error);
        return;
      }

      const ceremony = await authenticateWithPasskey(options.options);
      if ('error' in ceremony) {
        setError(ceremony.error);
        return;
      }

      const verified = await send('passkey-login-verify', {
        challengeId: options.challengeId,
        response: ceremony.response,
      });
      if (verified.error) {
        setError(verified.error);
        return;
      }

      await dispatch(loggedIn());
    } finally {
      setLoading(false);
    }
  }

  async function onCreateFirstPasskey() {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const subject = {
        password,
        userName: userName.trim(),
        displayName: displayName.trim() || undefined,
      };

      const options = await send('passkey-register-options', subject);
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
        ...subject,
        challengeId: options.challengeId,
        response: ceremony.response,
      });
      if (verified.error) {
        setError(verified.error);
        return;
      }

      await dispatch(loggedIn());
    } finally {
      setLoading(false);
    }
  }

  if (!supported) {
    return (
      <Text
        style={{ marginTop: 10, color: theme.warningText, lineHeight: 1.4 }}
      >
        <Trans>
          This browser cannot use passkeys. Try a current version of Firefox,
          Chrome, Edge or Safari, or choose another login method below.
        </Trans>
      </Text>
    );
  }

  if (ownerExists === null) {
    return null;
  }

  if (ownerExists) {
    return (
      <View style={{ marginTop: 5 }}>
        <ButtonWithLoading
          variant="primary"
          isLoading={loading}
          onPress={onSignIn}
          style={{
            fontSize: 15,
            padding: isNarrowWidth ? 10 : undefined,
            alignSelf: isNarrowWidth ? 'stretch' : 'flex-end',
            minWidth: 220,
          }}
        >
          <Trans>Sign in with a passkey</Trans>
        </ButtonWithLoading>
        <Text
          style={{
            ...styles.verySmallText,
            color: theme.pageTextLight,
            marginTop: 8,
          }}
        >
          <Trans>
            Your device will ask for your fingerprint, face, PIN or security
            key.
          </Trans>
        </Text>
      </View>
    );
  }

  const canSubmit =
    userName.trim() !== '' && (!passwordConfigured || password !== '');

  return (
    <View style={{ marginTop: 5, gap: 10 }}>
      <Text style={{ color: theme.warningText, lineHeight: 1.4 }}>
        <Trans>
          No one has signed in with a passkey yet. The first person to create
          one becomes the{' '}
          <Text style={{ fontWeight: 'bold' }}>server owner</Text>, which cannot
          be changed from the app afterwards.
        </Trans>
      </Text>

      {passwordConfigured && (
        <ResponsiveInput
          autoFocus
          type="password"
          placeholder={t('Server password')}
          value={password}
          onChangeValue={setPassword}
        />
      )}
      <ResponsiveInput
        type="text"
        placeholder={t('Your username')}
        value={userName}
        onChangeValue={setUserName}
        onEnter={canSubmit ? onCreateFirstPasskey : undefined}
      />
      <ResponsiveInput
        type="text"
        placeholder={t('Display name (optional)')}
        value={displayName}
        onChangeValue={setDisplayName}
        onEnter={canSubmit ? onCreateFirstPasskey : undefined}
      />

      <ButtonWithLoading
        variant="primary"
        isLoading={loading}
        isDisabled={!canSubmit}
        onPress={onCreateFirstPasskey}
        style={{
          fontSize: 15,
          padding: isNarrowWidth ? 10 : undefined,
          alignSelf: isNarrowWidth ? 'stretch' : 'flex-end',
          minWidth: 220,
        }}
      >
        <Trans>Create the first passkey</Trans>
      </ButtonWithLoading>
    </View>
  );
}
