// Documentation-only renderer. No browser, chain access or SDK runtime imports.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {instance} from '@viz-js/viz';
import {Resvg} from '@resvg/resvg-js';

const directory=process.argv[2]?path.resolve(process.argv[2]):path.dirname(fileURLToPath(import.meta.url));
const viz=await instance();
for(const name of ['architecture','job-lifecycle','cancellation','reopening']){
  const svg=viz.renderString(fs.readFileSync(path.join(directory,name+'.dot'),'utf8'),{format:'svg',engine:'dot'});
  fs.writeFileSync(path.join(directory,name+'.svg'),svg);
  const png=new Resvg(svg,{
    background:'white',fitTo:{mode:'width',value:2200},
    font:{loadSystemFonts:true,defaultFontFamily:'DejaVu Sans'},
  }).render();
  fs.writeFileSync(path.join(directory,name+'.png'),png.asPng());
  console.log(`${name}: SVG and ${png.width}x${png.height} PNG`);
}
