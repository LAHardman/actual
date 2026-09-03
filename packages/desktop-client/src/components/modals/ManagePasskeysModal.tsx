import { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { ResponsiveInput } from '@actual-app/components/input';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type { PasskeyCredentialSummary } from '@actual-app/core/types/models';

import { Error as ErrorAlert } from '#components/alerts';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { getPasskeyErrors } from '#util/error';
import { createPasskey, passkeysSupported } from '#util/passkeys';

export function ManagePasskeysModal() {
  const { t } = useTranslation();

  const [credentials, setCredentials] = useState<PasskeyCredentialSummary[]>(
    [],
  );
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const showError = useCallback(
    (reason: string) =>
      setError(
        getPasskeyErrors(reason) ??
          t('Something went wrong ({{reason}})', { reason }),
      ),
    [t],
  );

  const load = useCallback(async () => {
    const result = await send('passkey-list');
    if ('error' in result) {
      showError(result.error);
      return;
    }
    setCredentials(result.credentials);
    setLoaded(true);
  }, [showError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onAddDevice() {
    if (adding) return;
    setError(null);
    setAdding(true);
    try {
      const options = await send('passkey-register-options', {});
      if ('error' in options) {
        showError(options.error);
        return;
      }
      const ceremony = await createPasskey(options.options);
      if ('error' in ceremony) {
        showError(ceremony.error);
        return;
      }
      const verified = await send('passkey-register-verify', {
        challengeId: options.challengeId,
        response: ceremony.response,
        name: newName.trim() || undefined,
      });
      if (verified.error) {
        showError(verified.error);
        return;
      }
      setNewName('');
      await load();
    } finally {
      setAdding(false);
    }
  }

  async function onRename(credentialId: string) {
    setError(null);
    const result = await send('passkey-rename', {
      credentialId,
      name: editingName,
    });
    if (result.error) {
      showError(result.error);
      return;
    }
    setEditingId(null);
    await load();
  }

  async function onRemove(credentialId: string) {
    setError(null);
    const result = await send('passkey-delete', { credentialId });
    if (result.error) {
      showError(result.error);
      return;
    }
    await load();
  }

  const isLast = credentials.length <= 1;

  function formatDate(timestamp: number | null) {
    if (!timestamp) return t('never');
    return new Date(timestamp).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  return (
    <Modal name="manage-passkeys">
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Your passkeys')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />

          <View style={{ flexDirection: 'column', gap: 12 }}>
            {loaded && credentials.length === 0 && (
              <Text style={{ color: theme.pageTextLight }}>
                <Trans>You have no passkeys on this server.</Trans>
              </Text>
            )}

            {credentials.map(credential => (
              <View
                key={credential.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 4,
                  backgroundColor: theme.tableRowBackgroundHover,
                }}
              >
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  {editingId === credential.id ? (
                    <ResponsiveInput
                      autoFocus
                      type="text"
                      value={editingName}
                      onChangeValue={setEditingName}
                      onEnter={() => onRename(credential.id)}
                      onEscape={() => setEditingId(null)}
                    />
                  ) : (
                    <Text style={{ fontWeight: 600 }}>
                      {credential.name ?? t('Unnamed passkey')}
                    </Text>
                  )}
                  <Text
                    style={{
                      ...styles.verySmallText,
                      color: theme.pageTextLight,
                    }}
                  >
                    {credential.backedUp
                      ? t('Synced passkey')
                      : t('This device only')}
                    {' · '}
                    {t('Added {{date}}', {
                      date: formatDate(credential.createdAt),
                    })}
                    {' · '}
                    {t('Last used {{date}}', {
                      date: formatDate(credential.lastUsedAt),
                    })}
                  </Text>
                </View>

                {editingId === credential.id ? (
                  <>
                    <Button variant="bare" onPress={() => setEditingId(null)}>
                      <Trans>Cancel</Trans>
                    </Button>
                    <Button
                      variant="primary"
                      onPress={() => onRename(credential.id)}
                    >
                      <Trans>Save</Trans>
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="bare"
                      onPress={() => {
                        setEditingId(credential.id);
                        setEditingName(credential.name ?? '');
                      }}
                    >
                      <Trans>Rename</Trans>
                    </Button>
                    <Button
                      variant="bare"
                      isDisabled={isLast}
                      onPress={() => onRemove(credential.id)}
                      style={{ color: isLast ? undefined : theme.errorText }}
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  </>
                )}
              </View>
            ))}

            {isLast && loaded && credentials.length === 1 && (
              <Text
                style={{ ...styles.verySmallText, color: theme.pageTextLight }}
              >
                <Trans>
                  Your last passkey cannot be removed while passkeys are the
                  login method, so you cannot lock yourself out. Add another
                  device first.
                </Trans>
              </Text>
            )}

            <View
              style={{
                marginTop: 8,
                paddingTop: 12,
                borderTop: '1px solid ' + theme.tableBorder,
                gap: 8,
              }}
            >
              <Text style={{ fontWeight: 600 }}>
                <Trans>Add this device</Trans>
              </Text>
              {passkeysSupported() ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <ResponsiveInput
                    type="text"
                    placeholder={t('Name this device (optional)')}
                    value={newName}
                    onChangeValue={setNewName}
                    style={{ flex: 1 }}
                    onEnter={onAddDevice}
                  />
                  <ButtonWithLoading
                    variant="primary"
                    isLoading={adding}
                    onPress={onAddDevice}
                  >
                    <Trans>Create passkey</Trans>
                  </ButtonWithLoading>
                </View>
              ) : (
                <Text style={{ color: theme.warningText }}>
                  <Trans>This browser cannot create passkeys.</Trans>
                </Text>
              )}
            </View>

            {error && <ErrorAlert>{error}</ErrorAlert>}
          </View>
        </>
      )}
    </Modal>
  );
}
