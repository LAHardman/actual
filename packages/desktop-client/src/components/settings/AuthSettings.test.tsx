import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { useLoginMethod, useMultiuserEnabled } from '#components/ServerContext';
import { useSyncServerStatus } from '#hooks/useSyncServerStatus';
import { TestProviders } from '#mocks';

import { AuthSettings } from './AuthSettings';

vi.mock('#hooks/useSyncServerStatus', () => ({
  useSyncServerStatus: vi.fn(),
}));
vi.mock('#components/ServerContext', () => ({
  useMultiuserEnabled: vi.fn(),
  useLoginMethod: vi.fn(),
}));

const OFFLINE_WARNING = /server is offline\. login settings are unavailable\./i;

describe('AuthSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not render when server status is no-server', () => {
    vi.mocked(useSyncServerStatus).mockReturnValue('no-server');
    vi.mocked(useMultiuserEnabled).mockReturnValue(false);
    vi.mocked(useLoginMethod).mockReturnValue('password');

    const { container } = render(<AuthSettings />, { wrapper: TestProviders });

    expect(container.firstChild).toBeNull();
  });

  describe('when server is offline', () => {
    beforeEach(() => {
      vi.mocked(useSyncServerStatus).mockReturnValue('offline');
    });

    it('disables buttons and shows warning when login method is password', () => {
      vi.mocked(useMultiuserEnabled).mockReturnValue(false);
      vi.mocked(useLoginMethod).mockReturnValue('password');

      render(<AuthSettings />, { wrapper: TestProviders });

      expect(
        screen.getByRole('button', { name: /start using openid/i }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: /start using passkeys/i }),
      ).toBeDisabled();
      expect(screen.getByText(OFFLINE_WARNING)).toBeInTheDocument();
    });

    it('disables buttons and shows warning when login method is openid', () => {
      vi.mocked(useMultiuserEnabled).mockReturnValue(false);
      vi.mocked(useLoginMethod).mockReturnValue('openid');

      render(<AuthSettings />, { wrapper: TestProviders });

      expect(
        screen.getByRole('button', { name: /disable openid/i }),
      ).toBeDisabled();
      expect(screen.getByText(OFFLINE_WARNING)).toBeInTheDocument();
    });

    it('disables buttons and shows warning when login method is passkey', () => {
      vi.mocked(useMultiuserEnabled).mockReturnValue(false);
      vi.mocked(useLoginMethod).mockReturnValue('passkey');

      render(<AuthSettings />, { wrapper: TestProviders });

      expect(
        screen.getByRole('button', { name: /manage passkeys/i }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: /disable passkeys/i }),
      ).toBeDisabled();
      expect(screen.getByText(OFFLINE_WARNING)).toBeInTheDocument();
    });
  });

  describe('when server is online', () => {
    beforeEach(() => {
      vi.mocked(useSyncServerStatus).mockReturnValue('online');
    });

    it('offers both named-user methods with password login method', () => {
      vi.mocked(useMultiuserEnabled).mockReturnValue(false);
      vi.mocked(useLoginMethod).mockReturnValue('password');

      render(<AuthSettings />, { wrapper: TestProviders });

      expect(
        screen.getByRole('button', { name: /start using openid/i }),
      ).not.toBeDisabled();
      expect(
        screen.getByRole('button', { name: /start using passkeys/i }),
      ).not.toBeDisabled();
      expect(screen.queryByText(OFFLINE_WARNING)).not.toBeInTheDocument();
    });

    it('renders normally with openid login method', () => {
      vi.mocked(useMultiuserEnabled).mockReturnValue(false);
      vi.mocked(useLoginMethod).mockReturnValue('openid');

      render(<AuthSettings />, { wrapper: TestProviders });

      expect(
        screen.getByRole('button', { name: /disable openid/i }),
      ).not.toBeDisabled();
      expect(
        screen.queryByRole('button', { name: /manage passkeys/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(OFFLINE_WARNING)).not.toBeInTheDocument();
    });

    it('renders manage and disable with passkey login method', () => {
      vi.mocked(useMultiuserEnabled).mockReturnValue(false);
      vi.mocked(useLoginMethod).mockReturnValue('passkey');

      render(<AuthSettings />, { wrapper: TestProviders });

      expect(
        screen.getByRole('button', { name: /manage passkeys/i }),
      ).not.toBeDisabled();
      expect(
        screen.getByRole('button', { name: /disable passkeys/i }),
      ).not.toBeDisabled();
      expect(
        screen.queryByRole('button', { name: /disable openid/i }),
      ).not.toBeInTheDocument();
    });

    it('shows multi-user warning when multiuser is enabled with openid', () => {
      vi.mocked(useMultiuserEnabled).mockReturnValue(true);
      vi.mocked(useLoginMethod).mockReturnValue('openid');

      render(<AuthSettings />, { wrapper: TestProviders });

      expect(
        screen.getByText(/disabling openid will deactivate multi-user mode\./i),
      ).toBeInTheDocument();
    });

    it('shows multi-user warning when multiuser is enabled with passkeys', () => {
      vi.mocked(useMultiuserEnabled).mockReturnValue(true);
      vi.mocked(useLoginMethod).mockReturnValue('passkey');

      render(<AuthSettings />, { wrapper: TestProviders });

      expect(
        screen.getByText(
          /disabling passkeys will deactivate multi-user mode\./i,
        ),
      ).toBeInTheDocument();
    });
  });
});
