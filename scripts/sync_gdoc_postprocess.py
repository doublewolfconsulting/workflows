import zipfile, shutil
from lxml import etree

ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
W = lambda tag: f'{{{ns}}}{tag}'

def get_or_create(parent, tag, insert_pos=0):
    el = parent.find(W(tag))
    if el is None:
        el = etree.SubElement(parent, W(tag))
        parent.insert(insert_pos, el)
    return el

def replace_child(parent, new_el):
    tag = new_el.tag
    old = parent.find(tag)
    if old is not None:
        parent.remove(old)
    parent.append(new_el)

shutil.copy('output.docx', 'temp.docx')

with zipfile.ZipFile('temp.docx', 'r') as zin, \
     zipfile.ZipFile('output.docx', 'w', zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == 'word/document.xml':
            root = etree.fromstring(data)
            body = root.find(W('body'))

            # 1. Remove bookmarks
            for el in root.iter(W('bookmarkStart'), W('bookmarkEnd')):
                el.getparent().remove(el)

            # 2. Insert actual empty paragraph between every body element
            def make_spacer():
                spacer = etree.Element(W('p'))
                pPr = etree.SubElement(spacer, W('pPr'))
                sp = etree.SubElement(pPr, W('spacing'))
                sp.set(W('before'), '0')
                sp.set(W('after'), '0')
                return spacer

            def is_hr(p):
                pPr = p.find(W('pPr'))
                if pPr is None:
                    return False
                if pPr.find(W('pBdr')) is not None:
                    return True
                pStyle = pPr.find(W('pStyle'))
                if pStyle is not None and pStyle.get(W('val'), '').lower() in ('horizontalrule', 'horizontal rule'):
                    return True
                return False

            def is_list_item(el):
                pPr = el.find(W('pPr'))
                return pPr is not None and pPr.find(W('numPr')) is not None

            def get_list_level(el):
                pPr = el.find(W('pPr'))
                if pPr is None: return -1
                numPr = pPr.find(W('numPr'))
                if numPr is None: return -1
                ilvl = numPr.find(W('ilvl'))
                return int(ilvl.get(W('val'), '0')) if ilvl is not None else 0

            children = list(body)
            for i, child in reversed(list(enumerate(children))):
                # Insert spacer after every element except the last sectPr
                # and except between consecutive list items
                if child.tag != W('sectPr') and i < len(children) - 1:
                    next_el = children[i + 1]
                    if next_el.tag != W('sectPr'):
                        if is_list_item(child) and is_list_item(next_el):
                            child_level = get_list_level(child)
                            next_level = get_list_level(next_el)
                            if child_level > 0 and next_level == 0:
                                body.insert(i + 1, make_spacer())  # spacer before each new top-level item
                            # all other list-to-list transitions: no spacer
                        else:
                            body.insert(i + 1, make_spacer())

            # 3. Tables: full width (autofit) + black borders + cell padding
            for tbl in root.iter(W('tbl')):
                tblPr = get_or_create(tbl, 'tblPr')
                replace_child(tblPr, etree.fromstring(f'<w:tblW xmlns:w="{ns}" w:w="0" w:type="auto"/>'))
                replace_child(tblPr, etree.fromstring(f'<w:tblLayout xmlns:w="{ns}" w:type="autofit"/>'))
                # Remove fixed gridCol widths
                tblGrid = tbl.find(W('tblGrid'))
                if tblGrid is not None:
                    for gc in tblGrid.findall(W('gridCol')):
                        gc.attrib.pop(W('w'), None)
                for tc in tbl.iter(W('tc')):
                    tcPr = get_or_create(tc, 'tcPr')
                    replace_child(tcPr, etree.fromstring(f'''<w:tcBorders xmlns:w="{ns}">
                      <w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                      <w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                      <w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                      <w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    </w:tcBorders>'''))
                    replace_child(tcPr, etree.fromstring(f'''<w:tcMar xmlns:w="{ns}">
                      <w:top w:w="100" w:type="dxa"/>
                      <w:left w:w="150" w:type="dxa"/>
                      <w:bottom w:w="100" w:type="dxa"/>
                      <w:right w:w="150" w:type="dxa"/>
                    </w:tcMar>'''))

            # 4. Spacing + justify all body paragraphs
            for p in root.iter(W('p')):
                parent_tag = p.getparent().tag
                if parent_tag in (W('body'), W('tc')):
                    pPr = get_or_create(p, 'pPr')
                    if is_hr(p):
                        replace_child(pPr, etree.fromstring(
                            f'<w:spacing xmlns:w="{ns}" w:before="0" w:after="0"/>'))
                    else:
                        replace_child(pPr, etree.fromstring(
                            f'<w:spacing xmlns:w="{ns}" w:before="0" w:after="0"/>'))
                        replace_child(pPr, etree.fromstring(
                            f'<w:jc xmlns:w="{ns}" w:val="both"/>'))

            data = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
        zout.writestr(item, data)

print('Post-processing complete')
