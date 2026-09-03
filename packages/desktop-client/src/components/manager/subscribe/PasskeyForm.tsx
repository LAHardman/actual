import { useState } from 'react';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { ResponsiveInput } from '@actual-app/components/input';
import { SpaceBetween } from '@actual-app/components/space-between';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import type { PasskeyConfig } from '@actual-app/core/types/models';

import { FormField, FormLabel } from '#components/forms';
import { useServerURL } from '#components/ServerContext';

type PasskeyFormProps = {
  onSetPasskey: (config: PasskeyConfig) => Promise<void>;
  otherButtons?: ReactNode[];
};

export function PasskeyForm({ onSetPasskey, otherButtons }: PasskeyFormProps) {
  const { t } = useTranslation();
  const serverUrl = useServerURL() ?? '';
  const [rpName, setRpName] = useState('Actual Budget');
  const [loading, setLoading] = useState(false);

  const isSecure =
    serverUrl.startsWith('https://') ||
    /^https?:\/\/localhost(?::\d+)?/.test(serverUrl);

  async function onSubmit() {
    if (loading || !isSecure) return;
    setLoading(true);
    await onSetPasskey({ server_hostname: serverUrl, rpName: rpName.trim() });
    setLoading(false);
  }

  return (
    <SpaceBetween direction="vertical" style={{ alignItems: 'stretch' }}>
      <FormField style={{ flex: 1 }}>
        <FormLabel title={t('Server address')} htmlFor="passkey-server" />
        <ResponsiveInput
          id="passkey-server"
          type="text"
          value={serverUrl}
          disabled
        />
        <label
          htmlFor="passkey-server"
          style={{ ...styles.verySmallText, color: theme.pageTextLight }}
        >
          <Trans>
            Every passkey is bound to this address. Changing it later makes
            existing passkeys unusable, so set it to the address people will
            actually use before continuing.
          </Trans>
        </label>
        {!isSecure && (
          <Text style={{ ...styles.verySmallText, color: theme.errorText }}>
            <Trans>
              Passkeys need an https:// address. Put the server behind a
              certificate first.
            </Trans>
          </Text>
        )}
      </FormField>

      <FormField style={{ flex: 1 }}>
        <FormLabel
          title={t('Name shown on your device')}
          htmlFor="passkey-name"
        />
        <ResponsiveInput
          id="passkey-name"
          type="text"
          value={rpName}
          onChangeValue={setRpName}
        />
        <label
          htmlFor="passkey-name"
          style={{ ...styles.verySmallText, color: theme.pageTextLight }}
        >
          <Trans>
            What your phone or browser calls this server when it asks you to
            create or use a passkey.
          </Trans>
        </label>
      </FormField>

      <SpaceBetween style={{ justifyContent: 'flex-end' }}>
        {otherButtons}
        <ButtonWithLoading
          variant="primary"
          isLoading={loading}
          isDisabled={!isSecure}
          onPress={onSubmit}
        >
          <Trans>OK</Trans>
        </ButtonWithLoading>
      </SpaceBetween>
    </SpaceBetween>
  );
}
