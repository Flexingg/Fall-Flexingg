// Health galaxy live wallpaper (GLSL ES 1.00). One source for the Android wallpaper (packaged as
// an asset by app/build.gradle) and the in-app preview (imported by src/wallpaper/galaxy.ts).
// uA = calories, protein, carbs, fat fractions; uB = water, volume, fade, seconds; uRes = pixels.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec4 uA; uniform vec4 uB; uniform vec2 uRes;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*vn(p);p=p*2.03+vec2(17.1,9.7);a*=.5;}return v;}
float armf(float ph,float off,float w){float d=abs(mod(ph-off+3.14159,6.28318)-3.14159);return exp(-d*d*w);}
float stars(vec2 fc,float sc,float dens,float t){vec2 p=fc/sc;vec2 i=floor(p),f=fract(p);float h=hash(i);float on=step(1.-dens,h);vec2 c=vec2(hash(i+3.1),hash(i+7.7))*.6+.2;float d=length(f-c);float b=exp(-d*d*26.)*(.4+.6*hash(i+1.3));b*=.75+.25*sin(t*(1.+3.*hash(i+9.))+hash(i)*6.28);return on*b;}
void main(){
  float t=uB.w, fade=uB.z;
  float k=max(468./uRes.y, 228./uRes.x);
  vec2 pos=vec2(gl_FragCoord.x-.5*uRes.x, (uRes.y-gl_FragCoord.y)-uRes.y*232./468.)*k;
  float tl=-.5,cs=cos(tl),sn=sin(tl);
  vec2 q=vec2(cs*pos.x+sn*pos.y,-sn*pos.x+cs*pos.y); q.y/=.7;
  float r=length(q); float a=atan(q.y,q.x);
  float rot=t*.05;
  vec2 qn=vec2(cos(rot)*q.x+sin(rot)*q.y,-sin(rot)*q.x+cos(rot)*q.y);
  float ph=a-2.4*log(r+4.)-rot;
  float E0=108.*uA.y,E1=108.*uA.z,E2=108.*uA.w;
  float a0=armf(ph,0.,7.)*(1.-smoothstep(E0*.7,E0+1.,r));
  float a1=armf(ph,2.0944,7.)*(1.-smoothstep(E1*.7,E1+1.,r));
  float a2=armf(ph,4.1888,7.)*(1.-smoothstep(E2*.7,E2+1.,r));
  float armL=a0+a1+a2;
  float dd=armf(ph+.45,0.,9.)+armf(ph+.45,2.0944,9.)+armf(ph+.45,4.1888,9.);
  float dn=fbm(qn*.07+3.1);
  float dust=dd*smoothstep(.45,.75,dn)*exp(-r/80.)*smoothstep(10.,22.,r);
  float clump=smoothstep(.5,.78,fbm(qn*.3+7.));
  vec3 tint=a0*vec3(.96,.6,.48)+a1*vec3(.98,.78,.46)+a2*vec3(.69,.66,.93);
  vec3 knots=tint*clump*1.5*exp(-r/75.);
  float ld=exp(-r/38.)*(1.-smoothstep(95.,125.,r));
  float armGlow=armL*exp(-r/60.)*(.55+.9*fbm(qn*.2+11.));
  vec3 disk=vec3(.55,.68,1.)*(ld*.3+armGlow*1.1)*(1.-.75*dust);
  float rb=7.+16.*uA.x; float rbb=length(vec2(q.x,q.y*.75));
  float bulge=(.6+1.8*uA.x)*exp(-pow(rbb/rb,.55)*2.3);
  vec3 col=disk+vec3(1.,.78,.48)*bulge*(1.-.3*dust)+knots*(1.-.5*dust);
  float ring=exp(-pow((r-104.)/3.,2.));
  float aw=mod(a-t*.03,6.28318); float L=6.28318*uB.x;
  float mask=smoothstep(0.,.25,aw)*(1.-smoothstep(L-.25,L,aw));
  float lead=.3+.7*aw/max(L,.01);
  col+=vec3(.52,.72,.95)*ring*mask*lead*(.4+1.1*vn(qn*.6+5.))*.9;
  vec2 dj=vec2(-sn,cs); float s=dot(pos,dj), qd=dot(pos,vec2(-dj.y,dj.x));
  float Lj=(18.+80.*uB.y)*step(.001,uB.y); float as=abs(s);
  float jet=exp(-qd*qd/(2.+as*.05))*(1.-smoothstep(Lj*.4,Lj+.01,as))*smoothstep(3.,8.,as)*(.7+.3*sin(as*.25-t*3.));
  col+=vec3(.55,.9,.8)*jet*.9;
  col*=fade;
  float lum=clamp(dot(col,vec3(.4)),0.,1.5);
  vec3 sc=mix(vec3(1.),col/(max(max(col.r,col.g),col.b)+.001),.45);
  float st=stars(gl_FragCoord.xy,3.2/k,.01+.16*lum,t)*.8+stars(gl_FragCoord.xy+40.,7./k,.004+.05*lum,t)*1.2;
  vec3 bg=vec3(.015,.02,.05)+vec3(.18,.1,.35)*pow(fbm(pos*.012+5.),3.)*1.2+vec3(.05,.2,.18)*pow(fbm(pos*.011+30.),3.)*1.1;
  col+=bg*fade+sc*st*fade;
  col=1.-exp(-col*1.3);
  gl_FragColor=vec4(col,1.);
}
