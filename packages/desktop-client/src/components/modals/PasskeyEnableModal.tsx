import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Label } from '@actual-app/components/label';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import * as asyncStorage from '@actual-app/core/platform/server/asyncStorage';
import type { PasskeyConfig } from '@actual-app/core/types/models';

import { closeBudget } from '#budgetfiles/budgetfilesSlice';
import { Error } from '#components/alerts';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { PasskeyForm } from '#components/manager/subscribe/PasskeyForm';
import { useRefreshLoginMethods } from '#components/ServerContext';
import { popModal } from '#modals/modalsSlice';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { useDispatch } from '#redux';
import { getPasskeyErrors } from '#util/error';

type PasskeyEnableModalProps = Extract<
  ModalType,
  { name: 'enable-passkey' }
>['options'];

export function PasskeyEnableModal({
  onSave: originalOnSave,
}: PasskeyEnableModalProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();

  const [error, setError] = useState('');
  const refreshLoginMethods = useRefreshLoginMethods();

  async function onSave(config: PasskeyConfig) {
    try {
      const { error } =
        (await send('enable-passkey', { passkey: config })) || {};
      if (!error) {
        originalOnSave?.();
        try {
          await refreshLoginMethods();
          await asyncStorage.removeItem('user-token');
          await dispatch(closeBudget());
        } catch (e) {
          console.error('Failed to cleanup after enabling passkeys:', e);
          setError(
            t(
              'Passkeys were enabled but cleanup failed. Please refresh the application.',
            ),
          );
        }
      } else {
        setError(getPasskeyErrors(error) ?? t('Failed to enable passkeys.'));
      }
    } catch (e) {
      console.error('Failed to enable passkeys:', e);
      setError(t('Failed to enable passkeys. Please try again.'));
    }
  }

  return (
    <Modal name="enable-passkey">
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Enable passkeys')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />

          <View style={{ flexDirection: 'column' }}>
            <PasskeyForm
              onSetPasskey={onSave}
              otherButtons={[
                <Button
                  key="cancel"
                  variant="bare"
                  style={{ marginRight: 10 }}
                  onPress={() => dispatch(popModal())}
                >
                  <Trans>Cancel</Trans>
                </Button>,
              ]}
            />
            <Label
              style={{
                ...styles.verySmallText,
                color: theme.pageTextLight,
                paddingTop: 5,
              }}
              title={t('After enabling passkeys all sessions will be closed')}
            />
            <Label
              style={{
                ...styles.verySmallText,
                color: theme.pageTextLight,
              }}
              title={t(
                'You will then create the first passkey with the server password, and become the server owner',
              )}
            />
            <Label
              style={{
                ...styles.verySmallText,
                color: theme.warningText,
              }}
              title={t('The current password will be disabled')}
            />

            {error && <Error>{error}</Error>}
          </View>
        </>
      )}
    </Modal>
  );
}
