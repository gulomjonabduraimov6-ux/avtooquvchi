# AvtoO’quvchi

Ikkita alohida sahifa va bitta server:

| Sahifa | Manzil | Kim uchun |
|---|---|---|
| O'quvchi paneli | `https://SIZNING-SAYT/` | O'quvchilar |
| Admin paneli | `https://SIZNING-SAYT/admin` | Faqat admin (`ADMIN_PATH` bilan manzilni o'zgartirish mumkin) |

O'quvchi sahifasida admin kodi umuman yo'q. Admin amallari serverda alohida admin sessiyasi bilan himoyalangan: o'quvchi tokeni bilan admin API'ga kirib bo'lmaydi (sinab ko'rilgan, 401).

## Tez ishga tushirish (kompyuterda sinash)

Kerak: Node.js 20 yoki yangiroq.

    node server.js

Brauzerda `http://localhost:3000` (o'quvchi) va `http://localhost:3000/admin` (admin) oching.
Sinov rejimida (`SMS_PROVIDER=demo`) SMS yuborilmaydi: kod ekranda va server konsolida ko'rinadi.

Vaqtinchalik admin: login `admin`, parol `admin2026`. Kirgach "Sozlamalar" bo'limida o'zgartiring.

## Eskiz.uz orqali haqiqiy SMS

1. Eskiz kabinetida (my.eskiz.uz) hisobingiz va balansingiz borligini tekshiring.
2. `.env.example` ni `.env` ga nusxalab, `SMS_PROVIDER=eskiz`, `ESKIZ_EMAIL`, `ESKIZ_PASSWORD` ni kiriting.
3. **SMS matni.** Eskiz odatda faqat kabinetda tasdiqlangan matnlarni (shablon) yuboradi. Kabinetda quyidagi kabi matnni tasdiqlating va `SMS_TEXT` ni aynan shunga moslang: `AvtoO'quvchi tasdiqlash kodi: {code}`
4. Serverni ishga tushiring: `node --env-file=.env server.js`
5. O'z raqamingiz bilan bitta sinov ro'yxatdan o'tishini qiling.

Eslatma: Eskiz bilan haqiqiy aloqa men tomondan sinab ko'rilmagan (men internetga chiqa olmayman). So'rov formati Eskiz hujjatiga (login, keyin `message/sms/send`, `mobile_phone`, `message`, `from`) mos yozilgan va soxta Eskiz serveriga qarshi tekshirilgan. Birinchi sinovda xato chiqsa, server konsolida Eskiz javobi ko'rinadi, shuni menga yuboring.

## Internetga chiqarish

Server HTTPS orqasida turishi kerak (Render, Railway, VPS + Caddy/Nginx). Render misolida:

1. Papkani GitHub'ga yuklang. Render'da "New Web Service", Build command bo'sh, Start command `node server.js`.
2. "Environment" bo'limiga `.env.example` dagi o'zgaruvchilarni kiriting (`TRUST_PROXY=1` ham).
3. **Doimiy disk (Disk) qo'shing** va `DATA_FILE=/data/db.json` qiling. Aks holda server qayta ishga tushganda o'quvchilar bazasi o'chib ketadi.


## Ruxsat tizimi (24 soat)

1. O'quvchi ro'yxatdan o'tib, raqamini SMS bilan tasdiqlaydi. Ilovaga kirmaydi: "Arizangiz adminga yuborildi, 1-5 daqiqa kuting" oynasi chiqadi.
2. Ariza adminning "Arizalar" bo'limiga tushadi (panel har 8 soniyada o'zi yangilanadi, yangi arizada signal va xabar chiqadi).
3. Admin "Ruxsat berish" ni bosadi. O'quvchining ekrani o'zi ochiladi va tepada 24 soatlik taymer ishga tushadi (taymer o'quvchi kirganda boshlanadi, tasdiqlangan paytdan emas).
4. Vaqt tugagach o'quvchi "Ruxsat so'rash" tugmasini bosadi, ariza yana adminga tushadi. Natijalar saqlanib turadi.
5. Admin faol o'quvchiga "+24 soat" qo'sha oladi yoki "To'xtatish" bilan ruxsatni olib qo'yadi.
6. Muddat `ACCESS_HOURS` bilan o'zgaradi (standart 24).

Admin o'zi yaratgan login/parolli o'quvchiga ruxsat avvaldan beriladi.

## AI yordamchi

Ikki variantdan bittasi kerak (kalit yo'q bo'lsa AI "sozlanmagan" deydi):

- **Gemini (bepul daraja bor):** aistudio.google.com/apikey dan kalit oling va `GEMINI_API_KEY` ga yozing. Model nomi o'zgarib turadi, kerak bo'lsa `GEMINI_MODEL` bilan almashtiring (standart `gemini-flash-latest`).
- **Anthropic (Claude, pullik):** console.anthropic.com dan kalit oling, `ANTHROPIC_API_KEY` ga yozing.

Ikkalasi ham bo'lsa `AI_PROVIDER=gemini` yoki `anthropic` deb tanlang.

## Test savollari va videolarni joylash

`public/bank.json` (yoki serverdagi `data/bank.json`) faylini almashtirish kifoya, sahifani qayta yig'ish shart emas:

    { "questions": [ { "t": "Mavzu", "tpl": "1", "q": "Savol", "o": ["A","B","C","D"], "a": 0, "e": "Izoh" } ],
      "videos":    [ { "t": "Mavzu", "title": "Dars", "d": "5 daqiqa", "u": "https://.../video.mp4", "x": "Tavsif" } ],
      "auto":      [ { "title": "Estakada", "d": "3 daqiqa", "u": "", "x": "Yo'riqnoma" } ] }

`a` to'g'ri javob raqami (0 = A). Faylingizni menga bersangiz, shu formatga o'zim o'tkazib beraman.

## Xavfsizlik (nima qilingan)

- Parollar `scrypt` bilan xeshlanadi, sessiya tokenlari xeshlangan holda saqlanadi.
- SMS kodi serverda saqlanadi (xeshlangan), 2 daqiqa amal qiladi, 3 ta xato urinish, bir raqamga 1 daqiqada 1 ta va soatiga 5 ta SMS.
- Kirish va SMS uchun IP bo'yicha cheklov (brute-force himoyasi).
- Rad etilgan o'quvchining sessiyasi darhol to'xtatiladi.

## Nima qilinmagan

- Telegram bot orqali kod yuborish (Eskiz ishlamasa, shuni qo'shish mumkin).
- Ma'lumotlar bazasi oddiy JSON fayl: yuzlab o'quvchi uchun yetadi. Minglab bo'lsa PostgreSQL'ga o'tkazish kerak.
- Zaxira nusxa: `data/db.json` faylini muntazam nusxalab turing.
