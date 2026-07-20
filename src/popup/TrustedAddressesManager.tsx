import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { getTrustedAddresses, removeTrustedAddress } from '../utils/storageHelper';

type TrustedAddressesManagerProps = {
  onClose: () => void;
};

export default function TrustedAddressesManager({ onClose }: TrustedAddressesManagerProps) {
  const [addresses, setAddresses] = useState<string[]>([]);

  useEffect(() => {
    // Load trusted addresses when component mounts
    getTrustedAddresses().then(setAddresses);
  }, []);

  const handleRemove = async (addr: string) => {
    await removeTrustedAddress(addr);
    // Refresh list after removal
    const updated = await getTrustedAddresses();
    setAddresses(updated);
  };

  return (
    <div className="trusted-manager-modal" style={modalStyle} role="dialog" aria-modal="true">
      <div className="modal-content" style={contentStyle}>
        <h2>Trusted Addresses</h2>
        {addresses.length === 0 ? (
          <p>No trusted addresses.</p>
        ) : (
          <ul>
            {addresses.map((addr) => (
              <li key={addr} style={listItemStyle}>
                <span>{addr}</span>
                <button onClick={() => handleRemove(addr)} style={removeBtnStyle}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <button onClick={onClose} style={closeBtnStyle}>Close</button>
      </div>
    </div>
  );
}

// Simple inline styles for demonstration; replace with your design system as needed.
const modalStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const contentStyle: CSSProperties = {
  background: 'var(--tier-accent-light, #fff)',
  padding: '1rem',
  borderRadius: '8px',
  minWidth: '300px',
  maxHeight: '80vh',
  overflowY: 'auto',
};

const listItemStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '0.5rem',
};

const removeBtnStyle: CSSProperties = {
  background: '#e53935',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  padding: '0.25rem 0.5rem',
  cursor: 'pointer',
};

const closeBtnStyle: CSSProperties = {
  marginTop: '1rem',
  padding: '0.5rem 1rem',
  background: '#757575',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
};
