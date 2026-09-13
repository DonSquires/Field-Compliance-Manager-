import { useState } from 'react';
import { Bluetooth, Printer, RefreshCw } from 'lucide-react';
import { buildReceiptEscPos, buildReceiptText, type NoticeReceiptData, type ReceiptPaperWidth } from '../lib/thermalReceipt';
import { connectThermalPrinter, isWebBluetoothSupported, type ThermalPrinterConnection } from '../lib/useThermalPrinter';
import './NoticePrintActions.css';

/**
 * Prints a generated notice/infringement receipt two ways:
 *  - Bluetooth: raw ESC/POS bytes to a BLE thermal printer (Web Bluetooth).
 *  - Browser print: opens the OS print dialog with the receipt formatted to
 *    the chosen paper width -- the real path for WiFi/USB receipt printers,
 *    since browsers cannot open a raw socket to a network printer directly.
 */
export function NoticePrintActions({
  receipt,
  defaultPaperWidth = '58mm',
}: {
  receipt: NoticeReceiptData;
  defaultPaperWidth?: ReceiptPaperWidth;
}) {
  const [paperWidth, setPaperWidth] = useState<ReceiptPaperWidth>(defaultPaperWidth);
  const [connection, setConnection] = useState<ThermalPrinterConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const previewText = buildReceiptText(receipt, paperWidth);

  const connectPrinter = async () => {
    setBusy(true); setError(null); setStatus(null);
    try {
      const printer = await connectThermalPrinter();
      setConnection(printer);
      setStatus(`Connected to ${printer.diagnostics.deviceName ?? 'printer'}.`);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'The printer could not be connected.');
    } finally {
      setBusy(false);
    }
  };

  const printBluetooth = async () => {
    setBusy(true); setError(null); setStatus(null);
    try {
      let printer = connection;
      if (!printer || !printer.isConnected) {
        printer = await connectThermalPrinter();
        setConnection(printer);
      }
      await printer.write(buildReceiptEscPos(receipt, paperWidth));
      setStatus('Sent to printer.');
    } catch (printError) {
      setError(printError instanceof Error ? printError.message : 'The receipt could not be printed.');
    } finally {
      setBusy(false);
    }
  };

  const printViaBrowser = () => {
    const printWindow = window.open('', '_blank', 'width=420,height=640');
    if (!printWindow) {
      setError('The print window could not open. Allow pop-ups for this site and try again.');
      return;
    }
    const widthMm = paperWidth === '80mm' ? 80 : paperWidth === '58mm' ? 58 : 210;
    printWindow.document.write(`<!doctype html><html><head><title>${receipt.noticeNumber}</title><style>
      @page { size: ${widthMm}mm auto; margin: 4mm; }
      body { font-family: 'Courier New', monospace; white-space: pre-wrap; font-size: 12px; margin: 0; }
    </style></head><body>${previewText.replace(/</g, '&lt;')}</body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };

  return (
    <div className="notice-print-actions" aria-label="Print notice">
      {error && <div className="notice-print-message is-error" role="alert">{error}</div>}
      {status && <div className="notice-print-message is-success" role="status">{status}</div>}
      <div className="notice-print-controls">
        <label><span>Paper</span><select value={paperWidth} onChange={(event) => setPaperWidth(event.target.value as ReceiptPaperWidth)}>
          <option value="58mm">58mm receipt</option>
          <option value="80mm">80mm receipt</option>
        </select></label>
        <button type="button" onClick={printViaBrowser} title="Print via a WiFi/USB printer registered with this device">
          <Printer size={15} /> Print (WiFi/USB)
        </button>
        {isWebBluetoothSupported() ? (
          <button type="button" disabled={busy} onClick={() => void printBluetooth()} title="Print via a Bluetooth (BLE) thermal printer">
            {busy ? <RefreshCw size={15} className="is-spinning" /> : <Bluetooth size={15} />} {connection?.isConnected ? 'Print again' : 'Print via Bluetooth'}
          </button>
        ) : (
          <span className="notice-print-unsupported">Bluetooth printing needs Chrome or Edge (desktop or Android).</span>
        )}
        {isWebBluetoothSupported() && !connection && (
          <button type="button" disabled={busy} onClick={() => void connectPrinter()} className="notice-print-secondary">Pair a printer</button>
        )}
      </div>
      <details className="notice-print-preview">
        <summary>Preview receipt text</summary>
        <pre>{previewText}</pre>
      </details>
    </div>
  );
}
