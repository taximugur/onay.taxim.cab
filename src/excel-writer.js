const ExcelJS = require('exceljs');
const logger = require('./logger');

async function writeExcel(records, outputPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Shell ExtraCard Bot';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Müşteri Onayı Bekleyen');

  sheet.columns = [
    { header: 'Referans No', key: 'referansNo', width: 15 },
    { header: 'İsim', key: 'isim', width: 15 },
    { header: 'Soyisim', key: 'soyisim', width: 15 },
    { header: 'Kart No', key: 'kartNo', width: 22 },
    { header: 'GSM', key: 'gsm', width: 15 },
    { header: 'Plaka', key: 'plaka', width: 12 },
    { header: 'Gönderilen SMS', key: 'gonderilenSms', width: 15 },
    { header: 'Manuel SMS Limiti', key: 'manuelSmsLimiti', width: 18 },
    { header: 'Kayıt Tarihi', key: 'kayitTarihi', width: 20 },
    { header: 'Son Kullanım Tarihi', key: 'sonKullanimTarihi', width: 20 },
  ];

  // Header stil — Shell sarısı
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF000000' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFCC00' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 20;

  // Veri satırları
  records.forEach((r, i) => {
    const row = sheet.addRow(r);
    if (i % 2 === 1) {
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF5F5F5' },
      };
    }
  });

  // Auto-filter
  sheet.autoFilter = {
    from: 'A1',
    to: `J${records.length + 1}`,
  };

  // Freeze header
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Border
  sheet.eachRow((row, rowNum) => {
    row.eachCell(cell => {
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    });
  });

  await workbook.xlsx.writeFile(outputPath);
  logger.success(`Excel yazıldı: ${outputPath} (${records.length} satır)`);
  return outputPath;
}

module.exports = { writeExcel };
