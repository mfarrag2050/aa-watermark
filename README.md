# AA Media Kit — Photopea

**Aç / افتح / Open:** [Photopea + eklenti](https://www.photopea.com#%7B%22environment%22%3A%7B%22plugins%22%3A%5B%7B%22name%22%3A%22AA%20Media%20Kit%22%2C%22url%22%3A%22https%3A//aa-mediakit.pages.dev/plugin.html%22%2C%22icon%22%3A%22https%3A//aa-mediakit.pages.dev/icon.png%22%7D%5D%7D%7D) → sağ paneldeki **AA Logo Watermark** düğmesine bas.

---

## 🇸🇦 العربية — طريقة الاستخدام

1. **أضف الصور** بإحدى الطرق: زر **⤵ Görseli al** (يسحب الصورة المفتوحة حالياً في Photopea)، أو اسحب الصور، أو اضغط لاختيارها، أو ارفع ملف **ZIP**.
2. **اختر المقاس:** `1080×720` / `1080×1080` / `1080×1350` / `978×548`.
3. **الخيارات:** **GIF olarak indir** (إخراج GIF) · **Logoyu sola yerleştir** (الشعار يساراً) · **Sonucu Photopea'da aç** (فتح الناتج داخل Photopea بدل التنزيل).
4. **ترتيب صور الـ GIF:** اسحب المقبض المرقّم (⠿ 1، 2، 3…) أعلى يسار كل صورة لتغيير الترتيب. الضغط على جسم الصورة يفتح محرّر القص (زووم بالعجلة + سحب).
5. اضغط **Logo Ekle ve İndir** لإضافة الشعار والتنزيل.

**الإخراج:** صورة واحدة → تُنزَّل باسم `...-logolu`. عدة صور → ملف `Logolu-Fotograflar.zip`.

---

## 🇹🇷 Türkçe — Kullanım

1. **Fotoğrafları ekleyin:** **⤵ Görseli al** düğmesi (Photopea'da açık görseli çeker) veya fotoğrafları sürükleyin / tıklayarak seçin / **ZIP** yükleyin.
2. **Boyutu seçin:** `1080×720` / `1080×1080` / `1080×1350` / `978×548`.
3. **Seçenekler:** **GIF olarak indir** · **Logoyu sola yerleştir** · **Sonucu Photopea'da aç** (indirmek yerine sonucu Photopea'da açar).
4. **GIF kare sırası:** Her fotoğrafın sol üstündeki numaralı tutamağı (⠿ 1, 2, 3…) sürükleyerek sırayı değiştirin. Görsele tıklamak kırpma editörünü açar (tekerlekle yakınlaştır + sürükle).
5. **Logo Ekle ve İndir** düğmesine basın.

**Çıktı:** Tek fotoğraf → `...-logolu` olarak iner. Birden fazla → `Logolu-Fotograflar.zip`.

---

## 🇬🇧 English — How to use

1. **Add photos:** **⤵ Görseli al** button (pulls the image currently open in Photopea), or drag photos / click to pick / upload a **ZIP**.
2. **Choose size:** `1080×720` / `1080×1080` / `1080×1350` / `978×548`.
3. **Options:** **GIF olarak indir** (export GIF) · **Logoyu sola yerleştir** (logo on the left) · **Sonucu Photopea'da aç** (open the result in Photopea instead of downloading).
4. **GIF frame order:** Drag the numbered handle (⠿ 1, 2, 3…) at the top-left of each photo to reorder. Clicking the photo body opens the crop editor (wheel to zoom + drag).
5. Press **Logo Ekle ve İndir** to stamp the logo and download.

**Output:** One photo → downloads as `...-logolu`. Multiple → `Logolu-Fotograflar.zip`.

---

## الاستضافة

- **الرابط الأساسي (Cloudflare Pages):** https://aa-mediakit.pages.dev/plugin.html — مشروع `aa-mediakit` مربوط بفرع `main` في هذا الريبو، فكل دفع يُنشر تلقائياً.
- **نسخة GitHub Pages:** https://mfarrag2050.github.io/aa-watermark/plugin.html
- رابط التركيب في Photopea بضغطة واحدة في `launch-link.txt`، وتعريف الإضافة في `plugin.json`.
- نُقلت الأداة كاملة من `aaoperationai/aa-watermark` إلى هذا الريبو، بكل أقسامها: Watermark، Kartlar، Son dakika، Reels.

---

## الجديد في الإصدار 2

أضفناها من خبرة العمل اليومي على ألبومات الأناضول وبطاقاتها. **المخرجات الافتراضية لم تتغير**: صورة بمقاس 1080×1350 تخرج مطابقة بكسلا بكسل للإصدار السابق. كل الإضافات في قسم **Watermark**، والأقسام الأخرى لم تتغير. كل ميزة جديدة تعمل فقط عند تفعيلها.

### 1) مقاس الستوري والتصدير بكل المقاسات دفعة واحدة
- مقاس جديد **1080 x 1920 (Story)** في قسم Watermark: الشعار وفق قالب ستوري الأناضول المعتمد: 79×79px عند الموضع (62، 1731) أسفل اليسار، بشفافية 70%، بعيدا عن شريط الرد في الستوري. خيار «Logoyu sola yerleştir» لا يؤثر في الستوري.
- خيار **Tüm boyutlar (Instagram + X + Story)**: كل صورة تخرج بالمقاسات الثلاثة في ZIP واحد باسم `Logolu-Tum-Boyutlar.zip`، فيه ثلاثة مجلدات:
  `Instagram_1080x1350/`، `X_1080x1080/`، `Story_1080x1920/`.
  القص اليدوي يُطبَّق على المقاس المختار في القائمة فقط، والمقاسات الأخرى تُقص من الأصل على المركز.

### 2) كابشن الأناضول داخل الأداة
- تقرأ الأداة بيانات IPTC من صور الأناضول: العنوان والكابشن والمصور والمدينة وتاريخ التصوير.
- تظهر **i** على الصورة المصغرة، والوقوف عليها يعرض الكابشن.
- في محرر القص يظهر الكابشن كاملا مع زر **Kopyala** لنسخه.
- الفائدة: تعريف الأشخاص والأماكن من الكابشن لا من ملامح الصورة. وتاريخ التصوير يكشف صور الأرشيف حين يكون أقدم من تاريخ الخبر.

### 3) تنبيهات الجودة قبل التصدير
- **صور متشابهة:** يُقارَن كل زوج من الصور ببصمة بصرية (dHash). إذا تشابهت صورتان جدا ظهر تحت كل منهما «⚠ Benzer: #3»، حتى لا يتكرر المشهد أو الشخص في الألبوم.
- **دقة منخفضة:** إذا كانت الصورة ستُكبَّر لتملأ المقاس ظهر «⚠ Düşük çözünürlük» مع أبعادها الأصلية. في وضع «Tüm boyutlar» يُفحص كل مقاس من الثلاثة.
- ملخص التنبيهات يظهر فوق الصور المصغرة.

### 4) لوحة العرض على الديسك ومدة إطار الـ GIF
- خيار **Onay panosu oluştur** يجمع كل المخرجات في صورة واحدة `Onay-Panosu.jpg` (عرضها 2000px)، مرقمة من اليمين، ومقسمة حسب المقاس، وفوقها عنوان اختياري يُكتب بالعربية. ترسلها للديسك للاعتماد مباشرة.
  - مع ZIP توضع اللوحة داخل الملف.
  - مع صورة واحدة أو GIF تُنزَّل منفصلة.
  - مع «Sonucu Photopea'da aç» تُفتح في Photopea.
- **GIF kare süresi:** مدة الإطار من 1 إلى 3 ثوان، والافتراضي 2 كما كان. الاختيار يُحفظ في المتصفح.
