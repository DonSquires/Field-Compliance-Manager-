import { useEffect, useState } from 'react';
import { Bluetooth, Download, Printer, RefreshCw } from 'lucide-react';
import { buildReceiptEscPos, buildReceiptText, type NoticeReceiptData, type ReceiptPaperWidth } from '../lib/thermalReceipt';
import { connectThermalPrinter, isWebBluetoothSupported, type ThermalPrinterConnection } from '../lib/useThermalPrinter';
import { useOrganizationPrinterSettings, type PrinterPaperWidth } from '../hooks/useOrganizationPrinterSettings';
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
  organizationId,
}: {
  receipt: NoticeReceiptData;
  organizationId: string | null;
}) {
  const { settings, loading: settingsLoading, error: settingsError } = useOrganizationPrinterSettings(organizationId);
  const [paperWidth, setPaperWidth] = useState<PrinterPaperWidth>('58mm');
  const [connection, setConnection] = useState<ThermalPrinterConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settingsLoading) setPaperWidth(settings.paperWidth);
  }, [settings.paperWidth, settingsLoading]);

  const thermalPaperWidth: ReceiptPaperWidth = paperWidth === '58mm' ? '58mm' : '80mm';
  const previewText = buildReceiptText(receipt, thermalPaperWidth);

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
    if (paperWidth === 'a4') {
      setError('A4 uses the browser print dialog. Choose 58 mm or 80 mm before printing to a Bluetooth thermal printer.');
      return;
    }
    setBusy(true); setError(null); setStatus(null);
    try {
      let printer = connection;
      if (!printer || !printer.isConnected) {
        printer = await connectThermalPrinter();
        setConnection(printer);
      }
      await printer.write(buildReceiptEscPos(receipt, thermalPaperWidth));
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
    const pageSize = paperWidth === 'a4' ? 'A4' : `${paperWidth === '80mm' ? 80 : 58}mm auto`;
    printWindow.document.write(`<!doctype html><html><head><title>${receipt.noticeNumber}</title><style>
      @page { size: ${pageSize}; margin: ${paperWidth === 'a4' ? '15mm' : '4mm'}; }
      body { font-family: 'Courier New', monospace; white-space: pre-wrap; font-size: 12px; margin: 0; }
    </style></head><body>${previewText.replace(/</g, '&lt;')}</body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };

  const downloadReceipt = () => {
    const blob = new Blob([previewText], { type: 'text/plain;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `notice-${receipt.noticeNumber.replace(/[^A-Za-z0-9_-]+/g, '-')}.txt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  };

  return (
    <div className="notice-print-actions" aria-label="Print notice">
      {settingsError && <div className="notice-print-message is-error" role="alert">{settingsError}</div>}
      {error && <div className="notice-print-message is-error" role="alert">{error}</div>}
      {status && <div className="notice-print-message is-success" role="status">{status}</div>}
      <div className="notice-print-default" role="status">
        {settingsLoading
          ? 'Loading organisation printer defaults…'
          : settings.configured
            ? `Organisation default: ${settings.paperWidth.toUpperCase()} · ${settings.connectionType === 'bluetooth_escpos' ? 'Bluetooth thermal' : 'browser/OS print'}`
            : 'No organisation printer default is saved. Using 58 mm browser/OS print.'}
      </div>
      <div className="notice-print-controls">
        <label><span>Paper</span><select value={paperWidth} onChange={(event) => setPaperWidth(event.target.value as PrinterPaperWidth)}>
          <option value="58mm">58mm receipt</option>
          <option value="80mm">80mm receipt</option>
          <option value="a4">A4 page</option>
        </select></label>
        <button type="button" className={settings.connectionType === 'browser_print' ? 'is-preferred' : undefined} onClick={printViaBrowser} title="Print via a WiFi/USB printer registered with this device">
          <Printer size={15} /> {settings.connectionType === 'browser_print' ? 'Print via browser (default)' : 'Print via browser'}
        </button>
        <button type="button" onClick={downloadReceipt} title="Download the formatted receipt text">
          <Download size={15} /> Download receipt
        </button>
        {isWebBluetoothSupported() ? (
          <button type="button" className={settings.connectionType === 'bluetooth_escpos' ? 'is-preferred' : undefined} disabled={busy || paperWidth === 'a4'} onClick={() => void printBluetooth()} title={paperWidth === 'a4' ? 'Choose 58 mm or 80 mm for Bluetooth thermal printing' : 'Print via a Bluetooth (BLE) thermal printer'}>
            {busy ? <RefreshCw size={15} className="is-spinning" /> : <Bluetooth size={15} />} {connection?.isConnected ? 'Print again' : settings.connectionType === 'bluetooth_escpos' ? 'Print via Bluetooth (default)' : 'Print via Bluetooth'}
          </button>
        ) : (
          <span className="notice-print-unsupported">Bluetooth printing needs Chrome or Edge (desktop or Android).</span>
        )}
        {isWebBluetoothSupported() && !connection && paperWidth !== 'a4' && (
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
