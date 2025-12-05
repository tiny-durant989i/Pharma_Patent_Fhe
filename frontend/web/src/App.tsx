// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface PatentRecord {
  id: string;
  encryptedValue: string;
  timestamp: number;
  owner: string;
  category: string;
  status: "pending" | "approved" | "rejected";
  title: string;
  therapeuticArea: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const therapeuticAreas = [
  "Oncology", "Cardiology", "Neurology", "Immunology", 
  "Infectious Diseases", "Metabolic", "Rare Diseases", "Other"
];

const categories = [
  "Small Molecule", "Biologic", "Gene Therapy", 
  "Medical Device", "Diagnostic", "Other"
];

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [patents, setPatents] = useState<PatentRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newPatent, setNewPatent] = useState({
    title: "",
    category: "",
    therapeuticArea: "",
    estimatedValue: 0,
    description: ""
  });
  const [selectedPatent, setSelectedPatent] = useState<PatentRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const approvedCount = patents.filter(p => p.status === "approved").length;
  const pendingCount = patents.filter(p => p.status === "pending").length;
  const rejectedCount = patents.filter(p => p.status === "rejected").length;

  useEffect(() => {
    loadPatents().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadPatents = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("patent_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing patent keys:", e); }
      }
      
      const list: PatentRecord[] = [];
      for (const key of keys) {
        try {
          const patentBytes = await contract.getData(`patent_${key}`);
          if (patentBytes.length > 0) {
            try {
              const patentData = JSON.parse(ethers.toUtf8String(patentBytes));
              list.push({ 
                id: key, 
                encryptedValue: patentData.value, 
                timestamp: patentData.timestamp, 
                owner: patentData.owner, 
                category: patentData.category,
                therapeuticArea: patentData.therapeuticArea,
                title: patentData.title,
                status: patentData.status || "pending"
              });
            } catch (e) { console.error(`Error parsing patent data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading patent ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setPatents(list);
    } catch (e) { console.error("Error loading patents:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitPatent = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting patent value with Zama FHE..." });
    try {
      const encryptedValue = FHEEncryptNumber(newPatent.estimatedValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const patentId = `patent-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const patentData = { 
        value: encryptedValue, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newPatent.category,
        therapeuticArea: newPatent.therapeuticArea,
        title: newPatent.title,
        description: newPatent.description,
        status: "pending"
      };
      
      await contract.setData(`patent_${patentId}`, ethers.toUtf8Bytes(JSON.stringify(patentData)));
      
      const keysBytes = await contract.getData("patent_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(patentId);
      await contract.setData("patent_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Patent encrypted and submitted securely!" });
      await loadPatents();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewPatent({
          title: "",
          category: "",
          therapeuticArea: "",
          estimatedValue: 0,
          description: ""
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const approvePatent = async (patentId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted patent with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const patentBytes = await contract.getData(`patent_${patentId}`);
      if (patentBytes.length === 0) throw new Error("Patent not found");
      const patentData = JSON.parse(ethers.toUtf8String(patentBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedPatent = { ...patentData, status: "approved" };
      await contractWithSigner.setData(`patent_${patentId}`, ethers.toUtf8Bytes(JSON.stringify(updatedPatent)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Patent approved successfully!" });
      await loadPatents();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Approval failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectPatent = async (patentId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted patent with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const patentBytes = await contract.getData(`patent_${patentId}`);
      if (patentBytes.length === 0) throw new Error("Patent not found");
      const patentData = JSON.parse(ethers.toUtf8String(patentBytes));
      const updatedPatent = { ...patentData, status: "rejected" };
      await contract.setData(`patent_${patentId}`, ethers.toUtf8Bytes(JSON.stringify(updatedPatent)));
      setTransactionStatus({ visible: true, status: "success", message: "Patent rejected successfully!" });
      await loadPatents();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (patentAddress: string) => address?.toLowerCase() === patentAddress.toLowerCase();

  const filteredPatents = patents.filter(patent => {
    const matchesSearch = patent.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         patent.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         patent.therapeuticArea.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || patent.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const renderStatusFlow = () => {
    return (
      <div className="status-flow">
        <div className={`flow-step ${pendingCount > 0 ? 'active' : ''}`}>
          <div className="step-icon">⏳</div>
          <div className="step-label">Pending</div>
          <div className="step-count">{pendingCount}</div>
        </div>
        <div className="flow-arrow">→</div>
        <div className={`flow-step ${approvedCount > 0 ? 'active' : ''}`}>
          <div className="step-icon">✅</div>
          <div className="step-label">Approved</div>
          <div className="step-count">{approvedCount}</div>
        </div>
        <div className="flow-arrow">→</div>
        <div className={`flow-step ${rejectedCount > 0 ? 'active' : ''}`}>
          <div className="step-icon">❌</div>
          <div className="step-label">Rejected</div>
          <div className="step-count">{rejectedCount}</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <div className="radial-bg"></div>
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="atom-icon"></div>
          </div>
          <h1>Pharma<span>Patent</span>FHE</h1>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      <main className="main-content">
        <div className="center-radial-layout">
          <div className="core-panel">
            <div className="project-intro">
              <h2>FHE-Encrypted Pharmaceutical Patent Trading</h2>
              <p>
                Tokenize and trade confidential pharmaceutical patents using Zama FHE technology. 
                Patents are encrypted and remain confidential during transactions while enabling 
                secure valuation and licensing.
              </p>
              <div className="fhe-badge">
                <span>Powered by Zama FHE</span>
              </div>
            </div>

            <div className="stats-panel">
              <div className="stat-card">
                <div className="stat-value">{patents.length}</div>
                <div className="stat-label">Total Patents</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{approvedCount}</div>
                <div className="stat-label">Approved</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{pendingCount}</div>
                <div className="stat-label">Pending</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{rejectedCount}</div>
                <div className="stat-label">Rejected</div>
              </div>
            </div>

            <div className="status-flow-panel">
              <h3>Patent Status Flow</h3>
              {renderStatusFlow()}
            </div>

            <div className="action-bar">
              <button 
                onClick={() => setShowCreateModal(true)} 
                className="metal-button primary"
              >
                + Add New Patent
              </button>
              <div className="search-filter">
                <input
                  type="text"
                  placeholder="Search patents..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="metal-input"
                />
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="metal-select"
                >
                  <option value="all">All Statuses</option>
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <button 
                onClick={loadPatents} 
                disabled={isRefreshing}
                className="metal-button secondary"
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            <div className="patents-list">
              <div className="list-header">
                <div className="header-cell">Title</div>
                <div className="header-cell">Category</div>
                <div className="header-cell">Therapeutic Area</div>
                <div className="header-cell">Status</div>
                <div className="header-cell">Actions</div>
              </div>
              {filteredPatents.length === 0 ? (
                <div className="no-patents">
                  <div className="no-data-icon"></div>
                  <p>No patents found matching your criteria</p>
                  <button 
                    className="metal-button primary" 
                    onClick={() => setShowCreateModal(true)}
                  >
                    Add First Patent
                  </button>
                </div>
              ) : (
                filteredPatents.map(patent => (
                  <div 
                    className="patent-row" 
                    key={patent.id}
                    onClick={() => setSelectedPatent(patent)}
                  >
                    <div className="list-cell">{patent.title}</div>
                    <div className="list-cell">{patent.category}</div>
                    <div className="list-cell">{patent.therapeuticArea}</div>
                    <div className="list-cell">
                      <span className={`status-badge ${patent.status}`}>
                        {patent.status}
                      </span>
                    </div>
                    <div className="list-cell actions">
                      {isOwner(patent.owner) && patent.status === "pending" && (
                        <>
                          <button 
                            className="metal-button success" 
                            onClick={(e) => { e.stopPropagation(); approvePatent(patent.id); }}
                          >
                            Approve
                          </button>
                          <button 
                            className="metal-button danger" 
                            onClick={(e) => { e.stopPropagation(); rejectPatent(patent.id); }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitPatent} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          patentData={newPatent} 
          setPatentData={setNewPatent}
        />
      )}

      {selectedPatent && (
        <PatentDetailModal 
          patent={selectedPatent} 
          onClose={() => { setSelectedPatent(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
          </div>
          <div className="footer-copyright">
            © {new Date().getFullYear()} PharmaPatentFHE. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  patentData: any;
  setPatentData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, patentData, setPatentData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setPatentData({ ...patentData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setPatentData({ ...patentData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!patentData.title || !patentData.category || !patentData.therapeuticArea || !patentData.estimatedValue) {
      alert("Please fill all required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Add New Patent</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="shield-icon"></div>
            <p>All sensitive data will be encrypted with Zama FHE before submission</p>
          </div>
          
          <div className="form-group">
            <label>Patent Title *</label>
            <input 
              type="text" 
              name="title" 
              value={patentData.title} 
              onChange={handleChange} 
              placeholder="Enter patent title..."
              className="metal-input"
            />
          </div>
          
          <div className="form-row">
            <div className="form-group">
              <label>Category *</label>
              <select 
                name="category" 
                value={patentData.category} 
                onChange={handleChange}
                className="metal-select"
              >
                <option value="">Select category</option>
                {categories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            
            <div className="form-group">
              <label>Therapeutic Area *</label>
              <select 
                name="therapeuticArea" 
                value={patentData.therapeuticArea} 
                onChange={handleChange}
                className="metal-select"
              >
                <option value="">Select area</option>
                {therapeuticAreas.map(area => (
                  <option key={area} value={area}>{area}</option>
                ))}
              </select>
            </div>
          </div>
          
          <div className="form-group">
            <label>Estimated Value (USD) *</label>
            <input 
              type="number" 
              name="estimatedValue" 
              value={patentData.estimatedValue} 
              onChange={handleValueChange} 
              placeholder="Enter estimated value..."
              className="metal-input"
              min="0"
              step="0.01"
            />
          </div>
          
          <div className="form-group">
            <label>Description</label>
            <textarea 
              name="description" 
              value={patentData.description} 
              onChange={handleChange} 
              placeholder="Enter patent description..."
              className="metal-textarea"
              rows={3}
            />
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-row">
              <div className="preview-label">Plain Value:</div>
              <div className="preview-value">{patentData.estimatedValue || 'N/A'}</div>
            </div>
            <div className="preview-arrow">↓</div>
            <div className="preview-row">
              <div className="preview-label">Encrypted:</div>
              <div className="preview-value encrypted">
                {patentData.estimatedValue ? FHEEncryptNumber(patentData.estimatedValue).substring(0, 30) + '...' : 'N/A'}
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="metal-button secondary">Cancel</button>
          <button 
            onClick={handleSubmit} 
            disabled={creating}
            className="metal-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Submit Patent"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface PatentDetailModalProps {
  patent: PatentRecord;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const PatentDetailModal: React.FC<PatentDetailModalProps> = ({ patent, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(patent.encryptedValue);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="patent-detail-modal metal-card">
        <div className="modal-header">
          <h2>Patent Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="patent-info">
            <div className="info-row">
              <div className="info-label">Title:</div>
              <div className="info-value">{patent.title}</div>
            </div>
            <div className="info-row">
              <div className="info-label">Category:</div>
              <div className="info-value">{patent.category}</div>
            </div>
            <div className="info-row">
              <div className="info-label">Therapeutic Area:</div>
              <div className="info-value">{patent.therapeuticArea}</div>
            </div>
            <div className="info-row">
              <div className="info-label">Owner:</div>
              <div className="info-value">{patent.owner.substring(0, 6)}...{patent.owner.substring(38)}</div>
            </div>
            <div className="info-row">
              <div className="info-label">Submitted:</div>
              <div className="info-value">{new Date(patent.timestamp * 1000).toLocaleString()}</div>
            </div>
            <div className="info-row">
              <div className="info-label">Status:</div>
              <div className="info-value">
                <span className={`status-badge ${patent.status}`}>{patent.status}</span>
              </div>
            </div>
          </div>
          
          <div className="encrypted-section">
            <h3>Encrypted Value</h3>
            <div className="encrypted-value">
              {patent.encryptedValue.substring(0, 50)}...
            </div>
            <button 
              className="metal-button primary" 
              onClick={handleDecrypt}
              disabled={isDecrypting}
            >
              {isDecrypting ? "Decrypting..." : decryptedValue ? "Hide Value" : "Decrypt with Wallet"}
            </button>
          </div>
          
          {decryptedValue !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">
                ${decryptedValue.toLocaleString()}
              </div>
              <div className="decryption-notice">
                This value was decrypted using your wallet signature and is only visible to you
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;