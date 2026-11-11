pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let dayColumns = [];             // Array of 7 days: [{ dayName, dateFormatted, x }]
let employeeDataMap = new Map();        // Name -> Map of daily shifts
let activeShiftsToExport = [];          // Active shifts queued for .ics download
let cachedPdfDataBuffers = [];          // Cached raw PDF items across pages
let cachedDetectedYear = new Date().getFullYear();

const KNOWN_DEPTS = ['AGF', 'Vers', 'Kassa', 'Vuldienst', 'Brood', 'Slagerij', 'Logistiek', 'KW', 'Ecommerce', 'Bezorgen'];

const HEADER_FOOTER_KEYWORDS = [
  'medewerker', 'uitgeleend', 'ingeroosterde', 'uren', 'van', 'tot', 'pauze',
  'afwezig', 'totaal', 'rooster', 'vestiging', 'roosterniveau', 'status',
  'geinitialiseerd', 'afdrukdatum', 'pagina', 'andere', 'activ.'
];

const dropZone = document.getElementById('dropZone');
const pdfInput = document.getElementById('pdfInput');
const deptSelect = document.getElementById('deptSelect');
const employeeSelect = document.getElementById('employeeSelect');

dropZone.addEventListener('click', () => pdfInput.click());

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, false);
});

['dragenter', 'dragover'].forEach(eventName => {
  dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over'), false);
});

['dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'), false);
});

dropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    if (files[0].type === "application/pdf" || files[0].name.endsWith('.pdf')) {
      processPdfFile(files[0]);
    } else {
      document.getElementById('status').textContent = "⚠️ Please drop a valid PDF file.";
    }
  }
});

pdfInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    processPdfFile(e.target.files[0]);
  }
});

// Instantly re-parse and update preview & ICS when default department changes
deptSelect.addEventListener('change', () => {
  if (cachedPdfDataBuffers.length > 0) {
    reparseCachedData();
  }
});

employeeSelect.addEventListener('change', () => {
  renderShiftsForSelected();
});

async function processPdfFile(file) {
  const statusEl = document.getElementById('status');
  const previewCard = document.getElementById('previewCard');
  const nameContainer = document.getElementById('nameContainer');
  const deptContainer = document.getElementById('deptContainer');
  
  statusEl.textContent = `Reading "${file.name}"...`;
  previewCard.style.display = "none";
  nameContainer.style.display = "none";
  
  cachedPdfDataBuffers = [];
  dayColumns = [];

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      let pageItems = [];

      textContent.items.forEach(item => {
        const str = item.str.trim();
        if (!str) return;

        const yearMatch = str.match(/(20\d{2})-\d{2}/);
        if (yearMatch) {
          cachedDetectedYear = parseInt(yearMatch[1], 10);
        }

        pageItems.push({
          str: str,
          x: item.transform[4],
          y: item.transform[5],
          pageNum: pageNum
        });
      });

      cachedPdfDataBuffers.push(...parsePageItems(pageItems, pageNum));
    }

    for (const section of cachedPdfDataBuffers) {
      extractDayColumns(section.rows, cachedDetectedYear);
      if (dayColumns.length === 7) break;
    }

    if (dayColumns.length === 0) {
      statusEl.textContent = "⚠️ Could not detect header dates (Ma..Zo) in PDF.";
      return;
    }

    deptContainer.style.display = "block";
    reparseCachedData();

  } catch (err) {
    console.error(err);
    statusEl.textContent = "Error reading PDF file.";
  }
}

function parsePageItems(items, pageNum) {
  items.sort((a, b) => b.y - a.y);

  const rows = [];
  let currentRow = [];
  let lastY = null;

  items.forEach(item => {
    if (lastY === null || Math.abs(item.y - lastY) > 6) {
      if (currentRow.length > 0) {
        currentRow.sort((a, b) => a.x - b.x);
        rows.push(currentRow);
      }
      currentRow = [item];
      lastY = item.y;
    } else {
      currentRow.push(item);
    }
  });
  if (currentRow.length > 0) {
    currentRow.sort((a, b) => a.x - b.x);
    rows.push(currentRow);
  }

  let sectionBaseDept = deptSelect.value;
  for (const r of rows) {
    const rowText = r.map(i => i.str.trim()).join(' ');
    const matchedDept = KNOWN_DEPTS.find(d => d.toLowerCase() === rowText.toLowerCase());
    if (matchedDept) {
      sectionBaseDept = matchedDept;
      break;
    }
  }

  return [{ pageNum, dept: sectionBaseDept, rows }];
}

function extractDayColumns(rows, year) {
  dayColumns = [];
  const dateRegex = /(\d{2})-(\d{2})/;
  const dayNames = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];

  for (const row of rows) {
    const datesInRow = row.filter(i => dateRegex.test(i.str));
    if (datesInRow.length >= 5) {
      datesInRow.forEach((item, idx) => {
        const match = item.str.match(dateRegex);
        if (match) {
          const day = match[1];
          const month = match[2];
          dayColumns.push({
            dayName: dayNames[idx] || `Day ${idx + 1}`,
            dateFormatted: `${year}-${month}-${day}`,
            x: item.x
          });
        }
      });
      break;
    }
  }
}

function reparseCachedData() {
  employeeDataMap.clear();

  cachedPdfDataBuffers.forEach(section => {
    parseSectionEmployees(section);
  });

  populateEmployeeDropdown();
}

function parseSectionEmployees(section) {
  const isPauzeStr = (str) => /^(00:\d{2}|01:00)$/.test(str);
  const isTimeStr = (str) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(str);
  
  // Use the live dropdown selection as fallback department
  const baseDept = deptSelect.value || section.dept || "AGF";

  let currentEmployeeName = null;

  section.rows.forEach(row => {
    if (row.length === 0) return;

    row.forEach(item => {
      if (item.x < 110) {
        const str = item.str.trim();
        const lower = str.toLowerCase();

        if (HEADER_FOOTER_KEYWORDS.some(k => lower.includes(k))) {
          currentEmployeeName = null;
        } else if (!/\d/.test(str) && str.split(' ').length >= 2 && !KNOWN_DEPTS.includes(str)) {
          currentEmployeeName = str;
        }
      }
    });

    if (!currentEmployeeName) return;

    let subRowDept = baseDept;
    row.forEach(item => {
      if (item.x >= 80 && item.x <= 165) {
        const str = item.str.trim();
        const lower = str.toLowerCase();

        if (str && 
            !HEADER_FOOTER_KEYWORDS.some(k => lower.includes(k)) && 
            !/^\d+:\d+$/.test(str) && 
            !/^\d+$/.test(str)) {
          subRowDept = str.charAt(0).toUpperCase() + str.slice(1);
        }
      }
    });

    const itemsByCol = new Array(dayColumns.length).fill(null).map(() => []);

    row.forEach(item => {
      if (item.x < 195) return;

      let closestColIdx = 0;
      let minDiff = Infinity;
      dayColumns.forEach((col, idx) => {
        const diff = Math.abs(item.x - col.x);
        if (diff < minDiff) {
          minDiff = diff;
          closestColIdx = idx;
        }
      });

      itemsByCol[closestColIdx].push(item);
    });

    if (!employeeDataMap.has(currentEmployeeName)) {
      employeeDataMap.set(currentEmployeeName, new Map());
    }
    const userDayMap = employeeDataMap.get(currentEmployeeName);

    itemsByCol.forEach((colItems, colIdx) => {
      const colDate = dayColumns[colIdx].dateFormatted;
      if (!userDayMap.has(colDate)) {
        userDayMap.set(colDate, []);
      }

      const texts = colItems.map(i => i.str);

      if (texts.some(t => t.toLowerCase().includes('afwezig'))) {
        const existing = userDayMap.get(colDate);
        if (!existing.some(e => e.status === 'Afwezig')) {
          existing.push({ status: 'Afwezig' });
        }
        return;
      }

      const workTimes = [];
      const pauzeTimes = [];

      texts.forEach(t => {
        if (isPauzeStr(t)) {
          pauzeTimes.push(t);
        } else if (isTimeStr(t)) {
          workTimes.push(t);
        }
      });

      if (workTimes.length >= 2) {
        for (let tIdx = 0; tIdx < workTimes.length; tIdx += 2) {
          if (workTimes[tIdx + 1]) {
            const start = workTimes[tIdx];
            const end = workTimes[tIdx + 1];
            const pauzeVal = pauzeTimes[Math.floor(tIdx / 2)] || "00:00";

            userDayMap.get(colDate).push({
              status: 'Werk',
              dept: subRowDept,
              start: start,
              end: end,
              pauze: pauzeVal,
              summary: `Werk ${subRowDept} - ${pauzeVal} pauze tijd`
            });
          }
        }
      }
    });
  });
}

function populateEmployeeDropdown() {
  const statusEl = document.getElementById('status');
  const nameContainer = document.getElementById('nameContainer');

  // Remember current selection if already populated
  const currentSelection = employeeSelect.value;
  employeeSelect.innerHTML = "";
  
  const names = Array.from(employeeDataMap.keys());

  if (names.length === 0) {
    statusEl.textContent = "⚠️ No employee rows could be parsed.";
    return;
  }

  names.sort().forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    employeeSelect.appendChild(option);
  });

  if (names.includes(currentSelection)) {
    employeeSelect.value = currentSelection;
  } else {
    employeeSelect.value = names.find(n => n.toLowerCase().includes("brent de jong")) || names[0];
  }

  nameContainer.style.display = "block";
  statusEl.textContent = `Loaded roster for ${names.length} employee(s).`;

  renderShiftsForSelected();
}

function renderShiftsForSelected() {
  const statusEl = document.getElementById('status');
  const tableBody = document.getElementById('previewTableBody');
  const previewCard = document.getElementById('previewCard');
  const selectedName = employeeSelect.value;

  tableBody.innerHTML = "";
  activeShiftsToExport = [];
  const userDayMap = employeeDataMap.get(selectedName);

  let totalActiveShifts = 0;

  dayColumns.forEach(dayCol => {
    const dayEntries = userDayMap ? userDayMap.get(dayCol.dateFormatted) : null;

    if (dayEntries && dayEntries.length > 0) {
      dayEntries.forEach(entry => {
        const tr = document.createElement('tr');
        
        if (entry.status === 'Werk') {
          totalActiveShifts++;
          activeShiftsToExport.push({
            date: dayCol.dateFormatted,
            start: entry.start,
            end: entry.end,
            summary: entry.summary
          });

          tr.innerHTML = `
            <td><strong>${dayCol.dateFormatted} (${dayCol.dayName})</strong></td>
            <td>${entry.dept}</td>
            <td>${entry.start}</td>
            <td>${entry.end}</td>
            <td>${entry.pauze}</td>
            <td><span class="status-badge badge-work">${entry.summary}</span></td>
          `;
        } else {
          tr.innerHTML = `
            <td><strong>${dayCol.dateFormatted} (${dayCol.dayName})</strong></td>
            <td>-</td>
            <td>-</td>
            <td>-</td>
            <td>-</td>
            <td><span class="status-badge badge-afwezig">Afwezig</span></td>
          `;
        }
        tableBody.appendChild(tr);
      });
    } else {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${dayCol.dateFormatted} (${dayCol.dayName})</strong></td>
        <td>-</td>
        <td>-</td>
        <td>-</td>
        <td>-</td>
        <td><span class="status-badge badge-vrij">Vrij</span></td>
      `;
      tableBody.appendChild(tr);
    }
  });

  statusEl.textContent = `✅ Complete week loaded for ${selectedName}. ${totalActiveShifts} active shift(s) found.`;
  previewCard.style.display = "block";
}

document.getElementById('downloadBtn').addEventListener('click', () => {
  if (!activeShiftsToExport.length) {
    alert("No active shifts to export for this week.");
    return;
  }

  const selectedName = employeeSelect.value;
  let icsContent = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//PLUS Roster Generator//EN\r\nCALSCALE:GREGORIAN\r\n";

  activeShiftsToExport.forEach((shift, idx) => {
    const startIso = shift.date.replace(/-/g, '') + 'T' + shift.start.replace(':', '') + '00';
    let endIso = shift.date.replace(/-/g, '') + 'T' + shift.end.replace(':', '') + '00';

    icsContent += "BEGIN:VEVENT\r\n";
    icsContent += `UID:shift-${shift.date}-${shift.start.replace(':','')}-${idx}@plus\r\n`;
    icsContent += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z\r\n`;
    icsContent += `DTSTART:${startIso}\r\n`;
    icsContent += `DTEND:${endIso}\r\n`;
    icsContent += `SUMMARY:${shift.summary}\r\n`;
    icsContent += "LOCATION:PLUS Wemekamp\r\n";
    icsContent += "DESCRIPTION:Parsed shift from work roster\r\n";
    icsContent += "END:VEVENT\r\n";
  });

  icsContent += "END:VCALENDAR";

  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `work-roster-${selectedName.toLowerCase().replace(/\s+/g, '-')}.ics`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
});