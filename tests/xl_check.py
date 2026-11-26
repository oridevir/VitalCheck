import sys,openpyxl,zipfile
D=sys.argv[1]
for f in ['d-export.xlsx','m-export.xlsx','f-export.xlsx']:
    p=D+'/'+f
    print(f,'zip ok:', zipfile.ZipFile(p).testzip() is None)
    wb=openpyxl.load_workbook(p); ws=wb.active
    print(' sheet:',ws.title,'| rtl:',ws.sheet_view.rightToLeft,'| filter:',ws.auto_filter.ref,'| freeze:',ws.freeze_panes)
    for row in ws.iter_rows(values_only=True): print('  ',row)
    print(' D2 format:',ws['D2'].number_format,'| header bold:',ws['A1'].font.b,'| E2 fill:',ws['E2'].fill.fgColor.rgb)
