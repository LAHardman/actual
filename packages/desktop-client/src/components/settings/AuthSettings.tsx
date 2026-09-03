import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Label } from '@actual-app/components/label';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { useLoginMethod, useMultiuserEnabled } from '#components/ServerContext';
import { useSyncServerStatus } from '#hooks/useSyncServerStatus';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

import { Setting } from './UI';

export function AuthSettings() {
  const { t } = useTranslation();

  const multiuserEnabled = useMultiuserEnabled();
  const loginMethod = useLoginMethod();
  const dispatch = useDispatch();
  const serverStatus = useSyncServerStatus();

  // Hide the block entirely when no server is configured
  if (serverStatus === 'no-server') {
    return null;
  }

  const isOffline = serverStatus === 'offline';

  const methodLabel =
    loginMethod === 'openid'
      ? t('OpenID')
      : loginMethod === 'passkey'
        ? t('Passkeys')
        : t('Server password');

  return (
    <Setting
      primaryAction={
        <>
          <label>
            <Trans>Login method:</Trans>{' '}
            <label style={{ fontWeight: 'bold' }}>{methodLabel}</label>
          </label>
          {isOffline && (
            <View>
              <Text style={{ paddingTop: 5, color: theme.warningText }}>
                <Trans>
                  Server is offline. Login settings are unavailable.
                </Trans>
              </Text>
            </View>
          )}

          {loginMethod === 'password' && (
            <>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                <Button
                  id="start-using"
                  variant="normal"
                  isDisabled={isOffline}
                  onPress={() =>
                    dispatch(
                      pushModal({
                        modal: { name: 'enable-openid', options: {} },
                      }),
                    )
                  }
                >
                  <Trans>Start using OpenID</Trans>
                </Button>
                <Button
                  id="start-using-passkeys"
                  variant="normal"
                  isDisabled={isOffline}
                  onPress={() =>
                    dispatch(
                      pushModal({
                        modal: { name: 'enable-passkey', options: {} },
                      }),
                    )
                  }
                >
                  <Trans>Start using passkeys</Trans>
                </Button>
              </View>
              <Label
                style={{ paddingTop: 5 }}
                title={t(
                  'OpenID or passkeys are required to enable multi-user mode.',
                )}
              />
            </>
          )}

          {loginMethod === 'openid' && (
            <>
              <Button
                style={{ marginTop: '10px' }}
                variant="normal"
                isDisabled={isOffline}
                onPress={() =>
                  dispatch(
                    pushModal({
                      modal: { name: 'enable-password-auth', options: {} },
                    }),
                  )
                }
              >
                <Trans>Disable OpenID</Trans>
              </Button>
              {multiuserEnabled && (
                <Text style={{ paddingTop: 5, color: theme.errorText }}>
                  <Trans>
                    Disabling OpenID will deactivate multi-user mode.
                  </Trans>
                </Text>
              )}
            </>
          )}

          {loginMethod === 'passkey' && (
            <>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                <Button
                  variant="normal"
                  isDisabled={isOffline}
                  onPress={() =>
                    dispatch(
                      pushModal({
                        modal: { name: 'manage-passkeys', options: {} },
                      }),
                    )
                  }
                >
                  <Trans>Manage passkeys</Trans>
                </Button>
                <Button
                  variant="normal"
                  isDisabled={isOffline}
                  onPress={() =>
                    dispatch(
                      pushModal({
                        modal: { name: 'enable-password-auth', options: {} },
                      }),
                    )
                  }
                >
                  <Trans>Disable passkeys</Trans>
                </Button>
              </View>
              {multiuserEnabled && (
                <Text style={{ paddingTop: 5, color: theme.errorText }}>
                  <Trans>
                    Disabling passkeys will deactivate multi-user mode.
                  </Trans>
                </Text>
              )}
            </>
          )}
        </>
      }
    >
      <Text>
        <Trans>
          <strong>Authentication method</strong> modifies how users log in to
          the system.
        </Trans>
      </Text>
    </Setting>
  );
}
