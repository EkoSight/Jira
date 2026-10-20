/**
 * Starter templates, in the Soil Doctor brand and voice: confident, specific,
 * outcome-led — Data → Intelligence → Decision. English and Hindi.
 *
 * Figures, data rows, testimonials and event details in a starter are
 * examples and are marked `example: true`: a campaign cannot be approved
 * until someone replaces them with real ones (every number must earn its
 * place). Example wording elsewhere only raises a reminder.
 *
 * To add a starter, add an entry here; it appears under Templates for
 * everyone. Teams can also design, copy and upload their own on screen.
 */

const t = (en, hi = '') => ({ en, hi });
const SITE = 'https://soildoctor.in';
const LIGHT = { header: 'light', ground: 'sand' };

const bookPanel = (title, text) => ({
  type: 'panel', eyebrow: t('Book before you sow', 'बुवाई से पहले बुक करें'), title, text,
  button: { text: t('Book a soil test →', 'मिट्टी जाँच बुक करें →'), href: `${SITE}/book` },
  link: { text: t('Find a clinic near you', 'पास का क्लिनिक खोजें'), href: `${SITE}/clinics` },
});

export const STARTERS = [
  {
    key: 'newsletter', name: 'Monthly field notes', category: 'NEWSLETTER',
    description: 'A monthly round-up: what the network saw, two stories and one clear next step.',
    subject: t('What this month’s soil tests told us', 'इस महीने की मिट्टी जाँच ने क्या बताया'),
    preheader: t('Zinc is the new nitrogen, and a clinic in your district', 'ज़िंक की कमी, और आपके ज़िले में नया क्लिनिक'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'sand', eyebrow: t('Monthly field notes', 'मासिक खेत समाचार'),
        title: t('What this month’s soil tests told us', 'इस महीने की मिट्टी जाँच ने क्या बताया'), highlight: t('soil tests', 'मिट्टी जाँच'),
        text: t('Hello {{first_name|there}}, here is what changed in the fields we test — and what it means for the season ahead.', 'नमस्ते {{first_name|}}, जिन खेतों की हमने जाँच की, वहाँ क्या बदला — और आने वाले मौसम के लिए इसका क्या मतलब है।'),
        button: { text: t('Read the full notes →', 'पूरी जानकारी पढ़ें →'), href: `${SITE}/notes`, style: 'primary' } },
      { type: 'stats', example: true, eyebrow: t('This month across the network', 'इस महीने पूरे नेटवर्क में'),
        items: [
          { value: t('4,212'), label: t('soil tests run', 'मिट्टी जाँच') },
          { value: t('62%'), label: t('of plots low in zinc', 'खेतों में ज़िंक कम') },
          { value: t('38'), label: t('new villages', 'नए गाँव') },
          { value: t('₹1,850'), label: t('saved per acre on fertilizer', 'प्रति एकड़ खाद पर बचत') },
        ],
        note: t('Figures from Soil Doctor clinics, October 2026.', 'Soil Doctor क्लिनिक के आँकड़े, अक्टूबर 2026।') },
      { type: 'cards', example: true, items: [
        { tag: t('Advisory', 'सलाह'), tag_tone: 'info', title: t('Zinc is the new nitrogen', 'ज़िंक अब नई कमी है'),
          text: t('Six in ten plots we tested are short of zinc. A small dose at sowing protects yield more than extra urea.', 'हमारी जाँच में दस में से छह खेतों में ज़िंक कम है। बुवाई के समय थोड़ी मात्रा, अतिरिक्त यूरिया से ज़्यादा उपज बचाती है।'),
          link_text: t('Read the advisory', 'सलाह पढ़ें'), href: `${SITE}/advisory/zinc` },
        { tag: t('Field story', 'खेत की कहानी'), tag_tone: 'good', title: t('Meet the Soil Didis of Sehore', 'सीहोर की सॉइल दीदी से मिलिए'),
          text: t('Twelve women now run village clinics and test 400 plots a month between them.', 'बारह महिलाएँ अब गाँव के क्लिनिक चलाती हैं और मिलकर हर महीने 400 खेतों की जाँच करती हैं।'),
          link_text: t('Read their story', 'उनकी कहानी पढ़ें'), href: `${SITE}/stories` },
      ] },
      { type: 'pulse' },
      bookPanel(t('Know your soil before Rabi', 'रबी से पहले अपनी मिट्टी जानें'),
        t('A Soil Doctor test takes 30 minutes in your village and tells you exactly what your field needs.', 'Soil Doctor जाँच आपके गाँव में 30 मिनट में होती है और बताती है कि आपके खेत को ठीक-ठीक क्या चाहिए।')),
    ] },
  },
  {
    key: 'festival', name: 'Festival greeting', category: 'GREETING',
    description: 'A warm, short greeting for a festival or a season. {{festival}} is filled in by festival automations.',
    subject: t('Warm wishes on {{festival|this festival}}', '{{festival|त्योहार}} की हार्दिक शुभकामनाएँ'),
    preheader: t('From everyone at Soil Doctor', 'Soil Doctor परिवार की ओर से'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'dark', align: 'center', eyebrow: t('Season’s greetings', 'शुभकामनाएँ'),
        title: t('Happy {{festival|festival}}, {{first_name|friend}}', '{{festival|त्योहार}} की हार्दिक शुभकामनाएँ, {{first_name|मित्र}}'),
        text: t('May this season bring healthy soil, a rich harvest and prosperity to your family. Thank you for growing with us.', 'यह त्योहार आपके परिवार के लिए स्वस्थ मिट्टी, भरपूर फसल और समृद्धि लाए। हमारे साथ बढ़ने के लिए धन्यवाद।') },
      { type: 'text', align: 'center', text: t('With warm wishes,\n**The Soil Doctor team**', 'शुभकामनाओं सहित,\n**Soil Doctor टीम**') },
      { type: 'pulse' },
    ] },
  },
  {
    key: 'season_advisory', name: 'Season advisory for farmers', category: 'ADVISORY',
    description: 'Before sowing: what soils in the district show, what to do, and a test to book.',
    subject: t('Sow with the right dose this Rabi', 'इस रबी सही मात्रा से बुवाई करें'),
    preheader: t('Low zinc, medium phosphorus: what to add before you sow', 'ज़िंक कम, फॉस्फोरस मध्यम: बुवाई से पहले क्या डालें'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'sand', eyebrow: t('Rabi 2026 advisory', 'रबी 2026 सलाह'),
        title: t('Sow with the right dose this Rabi', 'इस रबी सही मात्रा से बुवाई करें'), highlight: t('right dose', 'सही मात्रा'),
        text: t('Wheat and mustard plots around {{city|your area}} are showing low zinc and medium phosphorus. A test before sowing tells you exactly how much to add — and how much to save.', '{{city|आपके क्षेत्र}} के आसपास गेहूँ और सरसों के खेतों में ज़िंक कम और फॉस्फोरस मध्यम है। बुवाई से पहले जाँच बताती है कि कितना डालना है — और कितना बचाना है।'),
        button: { text: t('Book a soil test →', 'मिट्टी जाँच बुक करें →'), href: `${SITE}/book`, style: 'primary' },
        button2: { text: t('Read the advisory', 'सलाह पढ़ें'), href: `${SITE}/advisory/rabi`, style: 'secondary' } },
      { type: 'data', example: true, eyebrow: t('A typical plot near you', 'आपके पास का एक सामान्य खेत'), title: t('What we are seeing before sowing', 'बुवाई से पहले क्या दिख रहा है'),
        rows: [
          { label: t('Nitrogen (N)', 'नाइट्रोजन (N)'), value: t('212 kg/ha'), level: 2 },
          { label: t('Phosphorus (P)', 'फॉस्फोरस (P)'), value: t('18 kg/ha'), level: 3 },
          { label: t('Potassium (K)', 'पोटाश (K)'), value: t('286 kg/ha'), level: 4 },
          { label: t('Zinc (Zn)', 'ज़िंक (Zn)'), value: t('0.4 ppm'), level: 1 },
          { label: t('Organic carbon', 'जैविक कार्बन'), value: t('0.42%'), level: 2 },
        ],
        note: t('Averages from 1,140 tests in the district, September–October 2026.', 'ज़िले की 1,140 जाँचों का औसत, सितंबर–अक्टूबर 2026।') },
      { type: 'steps', eyebrow: t('Before you sow', 'बुवाई से पहले'), title: t('Three things to do this week', 'इस हफ़्ते तीन काम'),
        items: [
          { title: t('Test the soil', 'मिट्टी की जाँच कराएँ'), text: t('30 minutes at a Soil Doctor clinic in your village.', 'आपके गाँव के Soil Doctor क्लिनिक में 30 मिनट।') },
          { title: t('Follow your dose card', 'खुराक कार्ड के अनुसार डालें'), text: t('Exact kg per acre of urea, DAP and zinc for your plot.', 'आपके खेत के लिए यूरिया, DAP और ज़िंक की प्रति एकड़ सही मात्रा।') },
          { title: t('Track the crop', 'फसल पर नज़र रखें'), text: t('Advisories on WhatsApp through the season.', 'पूरे मौसम WhatsApp पर सलाह।') },
        ] },
      bookPanel(t('Book before 15 November', '15 नवंबर से पहले बुक करें'), t('Clinics fill up in the two weeks before sowing.', 'बुवाई से पहले के दो हफ़्तों में क्लिनिक भर जाते हैं।')),
    ] },
  },
  {
    key: 'report_ready', name: 'Soil report ready', category: 'REPORT',
    description: 'Tells a farmer their report is ready: the readings, the dose, and a link to the full report.',
    subject: t('Your soil report is ready, {{first_name|friend}}', 'आपकी मिट्टी रिपोर्ट तैयार है, {{first_name|मित्र}}'),
    preheader: t('What your field needs this season, in kg per acre', 'इस मौसम आपके खेत को क्या चाहिए, प्रति एकड़'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'paper', eyebrow: t('Soil health report', 'मिट्टी स्वास्थ्य रिपोर्ट'),
        title: t('Your soil report is ready, {{first_name|friend}}', 'आपकी मिट्टी रिपोर्ट तैयार है, {{first_name|मित्र}}'), highlight: t('soil report', 'मिट्टी रिपोर्ट'),
        text: t('Here is what your field needs this season — and what it does not.', 'इस मौसम आपके खेत को क्या चाहिए — और क्या नहीं।') },
      { type: 'data', example: true, eyebrow: t('Your readings', 'आपकी रीडिंग'), title: t('Plot tested on 18 October', '18 अक्टूबर को जाँचा गया खेत'),
        rows: [
          { label: t('Nitrogen (N)', 'नाइट्रोजन (N)'), value: t('198 kg/ha'), level: 2 },
          { label: t('Phosphorus (P)', 'फॉस्फोरस (P)'), value: t('24 kg/ha'), level: 4 },
          { label: t('Potassium (K)', 'पोटाश (K)'), value: t('310 kg/ha'), level: 4 },
          { label: t('Zinc (Zn)', 'ज़िंक (Zn)'), value: t('0.5 ppm'), level: 1 },
          { label: t('pH'), value: t('7.8'), level: 3, status: t('Slightly alkaline', 'हल्का क्षारीय') },
        ] },
      { type: 'details', example: true, items: [
        { label: t('Crop', 'फसल'), value: t('Wheat', 'गेहूँ') },
        { label: t('Urea', 'यूरिया'), value: t('48 kg per acre', '48 किग्रा प्रति एकड़') },
        { label: t('DAP'), value: t('Not needed this season', 'इस मौसम ज़रूरत नहीं') },
        { label: t('Zinc sulphate', 'ज़िंक सल्फेट'), value: t('8 kg per acre', '8 किग्रा प्रति एकड़') },
      ] },
      { type: 'button', text: t('See your full report →', 'पूरी रिपोर्ट देखें →'), href: `${SITE}/report`, style: 'primary' },
      { type: 'text', text: t('Questions about your report? Reply to this email or call your Soil Didi.', 'रिपोर्ट के बारे में सवाल? इस ईमेल का जवाब दें या अपनी सॉइल दीदी को फ़ोन करें।') },
    ] },
  },
  {
    key: 'product', name: 'Product update', category: 'PRODUCT',
    description: 'One new capability, what it changes for the farmer, proof from the field and one action.',
    subject: t('Now testing for zinc and boron', 'अब ज़िंक और बोरॉन की भी जाँच'),
    preheader: t('12 parameters in one 30-minute test, at the same price', 'एक 30 मिनट की जाँच में 12 पैरामीटर, उसी क़ीमत पर'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'sand', eyebrow: t('New in every test', 'हर जाँच में नया'),
        title: t('Now testing for zinc and boron', 'अब ज़िंक और बोरॉन की भी जाँच'), highlight: t('zinc and boron', 'ज़िंक और बोरॉन'),
        text: t('Every Soil Doctor test now reports 12 parameters, including the micronutrients behind most yield gaps.', 'हर Soil Doctor जाँच अब 12 पैरामीटर बताती है, जिनमें वे सूक्ष्म पोषक तत्व भी हैं जिनसे अक्सर उपज घटती है।'),
        button: { text: t('See what is new →', 'क्या नया है, देखें →'), href: `${SITE}/whats-new`, style: 'primary' } },
      { type: 'cards', example: true, items: [
        { tag: t('12 parameters', '12 पैरामीटर'), tag_tone: 'good', title: t('Nitrogen to boron', 'नाइट्रोजन से बोरॉन तक'), text: t('One 30-minute test, one report.', 'एक 30 मिनट की जाँच, एक रिपोर्ट।') },
        { tag: t('Same price', 'वही क़ीमत'), tag_tone: 'info', title: t('No change for farmers', 'किसानों के लिए कोई बदलाव नहीं'), text: t('The test costs what it did last season.', 'जाँच की क़ीमत पिछले मौसम जितनी ही है।') },
        { tag: t('In Hindi', 'हिन्दी में'), tag_tone: 'info', title: t('Clear dose cards', 'साफ़ खुराक कार्ड'), text: t('Kg-per-acre advice in the farmer’s language.', 'किसान की भाषा में प्रति एकड़ सलाह।') },
        { tag: t('Same day', 'उसी दिन'), tag_tone: 'good', title: t('Reports on WhatsApp', 'WhatsApp पर रिपोर्ट'), text: t('Results reach the farmer’s phone before they leave the clinic.', 'किसान के क्लिनिक से निकलने से पहले नतीजे फ़ोन पर।') },
      ] },
      { type: 'quote', example: true, outcome: t('−22% fertilizer spend', 'खाद पर 22% कम ख़र्च'),
        text: t('We used to apply DAP by habit. The report showed our phosphorus was fine — we saved two bags an acre.', 'हम आदत से DAP डालते थे। रिपोर्ट ने बताया कि फॉस्फोरस ठीक है — हमने प्रति एकड़ दो बोरी बचाईं।'),
        name: t('Ramesh Patel', 'रमेश पटेल'), role: t('Farmer, Sehore', 'किसान, सीहोर') },
      { type: 'panel', eyebrow: t('For FPOs and partners', 'FPO और साझेदारों के लिए'), title: t('Bring it to your farmers', 'इसे अपने किसानों तक पहुँचाएँ'),
        text: t('We set up a clinic with your team in two weeks.', 'हम दो हफ़्तों में आपकी टीम के साथ क्लिनिक शुरू करते हैं।'),
        button: { text: t('Request a demo →', 'डेमो माँगें →'), href: `${SITE}/demo` } },
    ] },
  },
  {
    key: 'follow_up', name: 'Personal follow-up', category: 'FOLLOW_UP',
    description: 'A plain note from a person to a lead. Reads like an email, not a newsletter, which gets more replies.',
    subject: t('Following up on soil testing for {{organization|your farms}}', '{{organization|आपके खेतों}} की मिट्टी जाँच के बारे में'),
    preheader: t('Would a short call this week help?', 'क्या इस हफ़्ते एक छोटी कॉल ठीक रहेगी?'),
    design: { settings: { header: 'minimal', ground: 'paper' }, blocks: [
      { type: 'text', text: t('Hi {{first_name|there}},\n\nI wanted to follow up on our conversation about soil testing for {{organization|your farms}}.\n\nWould a short call this week help? Just reply with a time that suits you.\n\nThanks,\n**The Soil Doctor team**', 'नमस्ते {{first_name|}},\n\n{{organization|आपके खेतों}} की मिट्टी जाँच पर हमारी बातचीत के बारे में मैं फिर से बात करना चाहता था।\n\nक्या इस हफ़्ते एक छोटी कॉल ठीक रहेगी? अपना सुविधाजनक समय बताते हुए जवाब दें।\n\nधन्यवाद,\n**Soil Doctor टीम**') },
    ] },
  },
  {
    key: 'event_invite', name: 'Soil health camp invite', category: 'EVENT',
    description: 'An invitation to a camp, demo day or webinar: what, when, where, and how to prepare.',
    subject: t('Free soil testing camp in {{city|your district}}', '{{city|आपके ज़िले}} में मुफ़्त मिट्टी जाँच शिविर'),
    preheader: t('Bring a soil sample from each plot', 'हर खेत से मिट्टी का नमूना लाएँ'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'sand', eyebrow: t('You are invited', 'आप आमंत्रित हैं'),
        title: t('Soil health camp in {{city|your district}}', '{{city|आपके ज़िले}} में मिट्टी स्वास्थ्य शिविर'), highlight: t('Soil health camp', 'मिट्टी स्वास्थ्य शिविर'),
        text: t('Free soil testing for farmers, with on-the-spot advice from our agronomists.', 'किसानों के लिए मुफ़्त मिट्टी जाँच, हमारे कृषि विशेषज्ञों की तुरंत सलाह के साथ।'),
        button: { text: t('Reserve a slot →', 'स्लॉट बुक करें →'), href: `${SITE}/camp`, style: 'primary' } },
      { type: 'details', example: true, items: [
        { label: t('Date', 'तारीख़'), value: t('Saturday, 14 November 2026', 'शनिवार, 14 नवंबर 2026') },
        { label: t('Time', 'समय'), value: t('9:30 am – 2:00 pm', 'सुबह 9:30 – दोपहर 2:00') },
        { label: t('Place', 'स्थान'), value: t('Krishi Vigyan Kendra, Sehore', 'कृषि विज्ञान केंद्र, सीहोर') },
        { label: t('Bring', 'साथ लाएँ'), value: t('500 g of soil per plot', 'हर खेत से 500 ग्राम मिट्टी') },
      ] },
      { type: 'steps', eyebrow: t('How to take a sample', 'नमूना कैसे लें'), items: [
        { title: t('Pick five spots', 'पाँच जगह चुनें'), text: t('Walk the plot in a zig-zag and mark five points.', 'खेत में टेढ़ा-मेढ़ा चलकर पाँच जगह चुनें।') },
        { title: t('Dig 15 cm deep', '15 सेमी गहरा खोदें'), text: t('Take a thin slice from the side of each hole.', 'हर गड्ढे की दीवार से पतली परत लें।') },
        { title: t('Mix, dry, pack', 'मिलाएँ, सुखाएँ, पैक करें'), text: t('Dry in shade and pack 500 g in a clean bag with your name.', 'छाया में सुखाकर 500 ग्राम साफ़ थैली में अपने नाम के साथ पैक करें।') },
      ] },
      { type: 'text', text: t('Cannot come? [Find your nearest clinic](https://soildoctor.in/clinics).', 'नहीं आ सकते? [अपना नज़दीकी क्लिनिक खोजें](https://soildoctor.in/clinics)।') },
    ] },
  },
  {
    key: 'industry', name: 'FPO industry update', category: 'INDUSTRY',
    description: 'For farmer producer organizations: schemes and deadlines, your FPO’s figures, and a next step.',
    subject: t('Schemes and deadlines for FPOs this month', 'इस महीने FPO के लिए योजनाएँ और अंतिम तिथियाँ'),
    preheader: t('What is open, what closes soon, and your season so far', 'क्या खुला है, क्या जल्द बंद होगा, और आपका अब तक का मौसम'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'paper', eyebrow: t('For FPOs · Industry update', 'FPO के लिए · उद्योग समाचार'),
        title: t('Schemes and deadlines that matter this month', 'इस महीने ज़रूरी योजनाएँ और अंतिम तिथियाँ'), highlight: t('this month', 'इस महीने'),
        text: t('Dear {{first_name|member}}, here is what {{organization|your FPO}} can apply for now, and what closes soon.', 'प्रिय {{first_name|सदस्य}}, {{organization|आपका FPO}} अभी किन योजनाओं में आवेदन कर सकता है, और क्या जल्द बंद होगा।') },
      { type: 'cards', example: true, layout: 'stack', tone: 'sand', items: [
        { tag: t('Applications open', 'आवेदन खुले'), tag_tone: 'good', title: t('Village-level soil testing labs', 'गाँव स्तर की मिट्टी जाँच प्रयोगशाला'), text: t('Support for FPOs to run soil testing in member villages. Check your state portal for the current terms.', 'सदस्य गाँवों में मिट्टी जाँच के लिए FPO को सहायता। मौजूदा शर्तें अपने राज्य पोर्टल पर देखें।'), link_text: t('How to apply', 'आवेदन कैसे करें'), href: `${SITE}/schemes` },
        { tag: t('Closes soon', 'जल्द बंद'), tag_tone: 'warn', title: t('Input subsidy for reduced chemical use', 'कम रासायनिक उपयोग पर सहायता'), text: t('States are finalising plans; FPOs with soil data are best placed to qualify.', 'राज्य योजनाएँ तय कर रहे हैं; मिट्टी के आँकड़ों वाले FPO को लाभ मिलने की संभावना ज़्यादा है।'), link_text: t('Read more', 'और पढ़ें'), href: `${SITE}/schemes` },
      ] },
      { type: 'stats', example: true, eyebrow: t('Your FPO this season', 'इस मौसम आपका FPO'), items: [
        { value: t('1,240'), label: t('farmers tested', 'किसानों की जाँच') },
        { value: t('−18%'), label: t('urea used', 'यूरिया का उपयोग') },
        { value: t('₹14 lakh'), label: t('saved on inputs', 'इनपुट पर बचत') },
        { value: t('9'), label: t('villages covered', 'गाँव शामिल') },
      ] },
      { type: 'pulse' },
      { type: 'button', text: t('Talk to us →', 'हमसे बात करें →'), href: `${SITE}/contact`, style: 'primary' },
    ] },
  },
  {
    key: 'careers', name: 'Jobs and internships', category: 'CAREERS',
    description: 'Openings and programmes for students and graduates, each with where and how long.',
    subject: t('Build India’s soil intelligence network with us', 'भारत का मिट्टी नेटवर्क बनाने में हमारे साथ जुड़ें'),
    preheader: t('Internships and roles in agronomy, data and field work', 'कृषि, डेटा और फ़ील्ड में इंटर्नशिप और नौकरियाँ'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'sand', eyebrow: t('Careers at EkoSight', 'EkoSight में करियर'),
        title: t('Build India’s soil intelligence network', 'भारत का मिट्टी इंटेलिजेंस नेटवर्क बनाइए'), highlight: t('soil intelligence', 'मिट्टी इंटेलिजेंस'),
        text: t('Hello {{first_name|there}}, we are hiring people who want their work to show up in farmers’ fields.', 'नमस्ते {{first_name|}}, हम ऐसे लोगों को जोड़ रहे हैं जिनका काम किसानों के खेतों में दिखे।') },
      { type: 'cards', example: true, items: [
        { tag: t('Sehore · 6 months', 'सीहोर · 6 महीने'), tag_tone: 'info', title: t('Field agronomy intern', 'फ़ील्ड कृषि इंटर्न'), text: t('Run tests, write dose cards and learn from farmers.', 'जाँच करें, खुराक कार्ड बनाएँ और किसानों से सीखें।'), link_text: t('Apply', 'आवेदन करें'), href: `${SITE}/careers` },
        { tag: t('Noida · Full time', 'नोएडा · पूर्णकालिक'), tag_tone: 'info', title: t('Agri data analyst', 'कृषि डेटा विश्लेषक'), text: t('Turn thousands of soil tests into district advisories.', 'हज़ारों जाँचों को ज़िला सलाह में बदलें।'), link_text: t('Apply', 'आवेदन करें'), href: `${SITE}/careers` },
      ] },
      { type: 'button', text: t('See all openings →', 'सभी अवसर देखें →'), href: `${SITE}/careers`, style: 'primary' },
      { type: 'text', text: t('Know someone who would be a good fit? Forward this email to them.', 'कोई योग्य व्यक्ति जानते हैं? यह ईमेल उन्हें भेजें।') },
    ] },
  },
  {
    key: 'welcome', name: 'Welcome', category: 'WELCOME',
    description: 'The first email after someone joins: what Soil Doctor does and what happens next.',
    subject: t('Welcome to Soil Doctor, {{first_name|friend}}', 'Soil Doctor में आपका स्वागत है, {{first_name|मित्र}}'),
    preheader: t('Good decisions start with your soil', 'अच्छे फ़ैसले आपकी मिट्टी से शुरू होते हैं'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'sand', eyebrow: t('Welcome to Soil Doctor', 'Soil Doctor में स्वागत है'),
        title: t('Good decisions start with your soil', 'अच्छे फ़ैसले आपकी मिट्टी से शुरू होते हैं'), highlight: t('your soil', 'आपकी मिट्टी'),
        text: t('Hello {{first_name|there}}, thank you for joining. Soil Doctor tests soil in your village and turns the result into a clear decision: what to add, how much, and when.', 'नमस्ते {{first_name|}}, जुड़ने के लिए धन्यवाद। Soil Doctor आपके गाँव में मिट्टी जाँचता है और नतीजे को साफ़ फ़ैसले में बदलता है: क्या डालें, कितना, और कब।') },
      { type: 'steps', eyebrow: t('What happens next', 'आगे क्या होगा'), items: [
        { title: t('Your first advisory', 'आपकी पहली सलाह'), text: t('Seasonal advice for your crops arrives this week.', 'आपकी फसलों के लिए मौसमी सलाह इसी हफ़्ते।') },
        { title: t('Find a clinic', 'क्लिनिक खोजें'), text: t('There is a Soil Doctor clinic within reach of most villages we serve.', 'हमारे ज़्यादातर गाँवों के पास एक Soil Doctor क्लिनिक है।') },
        { title: t('Test before sowing', 'बुवाई से पहले जाँच'), text: t('Book a test two to three weeks before you sow.', 'बुवाई से दो-तीन हफ़्ते पहले जाँच बुक करें।') },
      ] },
      bookPanel(t('Book your first test', 'अपनी पहली जाँच बुक करें'), t('Thirty minutes, in your village, with a dose card you can use the same day.', 'तीस मिनट, आपके गाँव में, उसी दिन काम आने वाले खुराक कार्ड के साथ।')),
    ] },
  },
  {
    key: 'reengage', name: 'Still interested?', category: 'REENGAGE',
    description: 'For people quiet for months: one clear choice to stay, and an easy way out.',
    subject: t('Do you still want to hear from us?', 'क्या आप हमसे जुड़े रहना चाहते हैं?'),
    preheader: t('One click keeps you on the list', 'एक क्लिक से आप सूची में बने रहेंगे'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'dark', eyebrow: t('Still with us?', 'क्या आप साथ हैं?'),
        title: t('Do you still want to hear from us?', 'क्या आप हमसे जुड़े रहना चाहते हैं?'),
        text: t('We have not heard from you in a while. We only write when it is useful: seasonal advisories, new clinics near you, and the occasional festival greeting.', 'काफ़ी समय से आपसे बात नहीं हुई। हम तभी लिखते हैं जब काम का हो: मौसमी सलाह, पास के नए क्लिनिक, और कभी-कभी त्योहार की शुभकामनाएँ।'),
        button: { text: t('Yes, keep me on the list →', 'हाँ, मुझे सूची में रखें →'), href: `${SITE}/stay`, style: 'gold' },
        button2: { text: t('Unsubscribe', 'सदस्यता समाप्त करें'), href: '{{unsubscribe_url}}', style: 'link' } },
      { type: 'text', text: t('If we do not hear from you, we will stop writing after next month.', 'अगर हमें जवाब नहीं मिला, तो अगले महीने के बाद हम लिखना बंद कर देंगे।') },
    ] },
  },
  {
    key: 'impact_story', name: 'Impact story', category: 'STORY',
    description: 'A field story led by its outcome: the change, in the farmer’s words, with the numbers behind it.',
    subject: t('How farmers in Vidisha cut urea by a fifth', 'विदिशा के किसानों ने यूरिया पाँचवाँ हिस्सा कैसे घटाया'),
    preheader: t('Same yield, less fertilizer: what the soil data showed', 'उतनी ही उपज, कम खाद: मिट्टी के आँकड़ों ने क्या दिखाया'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'paper', example: true, eyebrow: t('Field story', 'खेत की कहानी'),
        title: t('How farmers in Vidisha cut urea by a fifth', 'विदिशा के किसानों ने यूरिया पाँचवाँ हिस्सा कैसे घटाया'), highlight: t('cut urea by a fifth', 'यूरिया पाँचवाँ हिस्सा घटाया'),
        text: t('Three seasons of testing showed most plots were getting more nitrogen than they could use.', 'तीन मौसम की जाँच ने दिखाया कि ज़्यादातर खेतों को ज़रूरत से ज़्यादा नाइट्रोजन मिल रहा था।') },
      { type: 'quote', example: true, outcome: t('−21% urea, same yield', '21% कम यूरिया, उतनी ही उपज'),
        text: t('We trusted the dose card for one season. The wheat came in the same, and we kept the money we used to spend on extra bags.', 'हमने एक मौसम खुराक कार्ड पर भरोसा किया। गेहूँ उतना ही हुआ, और अतिरिक्त बोरियों का पैसा बच गया।'),
        name: t('Sunita Yadav', 'सुनीता यादव'), role: t('Farmer and Soil Didi, Vidisha', 'किसान और सॉइल दीदी, विदिशा') },
      { type: 'stats', example: true, eyebrow: t('312 farmers, three seasons', '312 किसान, तीन मौसम'), items: [
        { value: t('−21%'), label: t('urea per acre', 'प्रति एकड़ यूरिया') },
        { value: t('₹1,640'), label: t('saved per acre', 'प्रति एकड़ बचत') },
      ] },
      { type: 'button', text: t('Read the full story →', 'पूरी कहानी पढ़ें →'), href: `${SITE}/stories/vidisha`, style: 'primary' },
    ] },
  },
  {
    key: 'csr_report', name: 'Programme update for partners', category: 'PARTNER',
    description: 'For CSR teams, NGOs and institutions: the programme’s reach and results, and what comes next.',
    subject: t('Your soil programme: the season in numbers', 'आपका मिट्टी कार्यक्रम: मौसम के आँकड़े'),
    preheader: t('Farmers reached, plots tested and what changed', 'कितने किसान, कितने खेत, और क्या बदला'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'sand', eyebrow: t('Partner update', 'साझेदार अपडेट'),
        title: t('Your programme, season one', 'आपका कार्यक्रम, पहला मौसम'), highlight: t('season one', 'पहला मौसम'),
        text: t('Dear {{first_name|partner}}, here is what the programme with {{organization|your organization}} achieved this season, from data, to intelligence, to decisions in the field.', 'प्रिय {{first_name|साझेदार}}, {{organization|आपकी संस्था}} के साथ कार्यक्रम ने इस मौसम क्या हासिल किया — आँकड़ों से समझ तक, और खेत में फ़ैसलों तक।') },
      { type: 'stats', example: true, eyebrow: t('Reach and results', 'पहुँच और नतीजे'), items: [
        { value: t('6,800'), label: t('farmers reached', 'किसानों तक पहुँच') },
        { value: t('9,420'), label: t('plots tested', 'खेतों की जाँच') },
        { value: t('24'), label: t('village clinics', 'गाँव क्लिनिक') },
        { value: t('41'), label: t('Soil Didis trained', 'प्रशिक्षित सॉइल दीदी') },
      ] },
      { type: 'data', example: true, eyebrow: t('What the soil showed', 'मिट्टी ने क्या दिखाया'), title: t('Share of plots by nutrient status', 'पोषक स्थिति के अनुसार खेत'),
        rows: [
          { label: t('Zinc', 'ज़िंक'), value: t('64% low', '64% कम'), level: 1 },
          { label: t('Organic carbon', 'जैविक कार्बन'), value: t('51% low', '51% कम'), level: 2 },
          { label: t('Phosphorus', 'फॉस्फोरस'), value: t('38% medium', '38% मध्यम'), level: 3 },
          { label: t('Potassium', 'पोटाश'), value: t('72% adequate', '72% पर्याप्त'), level: 4 },
        ] },
      { type: 'button', text: t('Open the programme dashboard →', 'कार्यक्रम डैशबोर्ड खोलें →'), href: `${SITE}/partners`, style: 'primary' },
    ] },
  },
  {
    key: 'dealer_scheme', name: 'Retailer update', category: 'RETAIL',
    description: 'For agri-input retailers and dealers: what nearby soils need, so stock matches demand.',
    subject: t('Stock what your farmers’ soil needs this Rabi', 'इस रबी किसानों की मिट्टी की ज़रूरत का स्टॉक रखें'),
    preheader: t('Soil data from villages near your shop', 'आपकी दुकान के पास के गाँवों की मिट्टी के आँकड़े'),
    design: { settings: LIGHT, blocks: [
      { type: 'hero', tone: 'paper', eyebrow: t('For retailers', 'विक्रेताओं के लिए'),
        title: t('Stock what your farmers’ soil needs', 'किसानों की मिट्टी की ज़रूरत का स्टॉक रखें'), highlight: t('soil needs', 'मिट्टी की ज़रूरत'),
        text: t('Soil Doctor tests in villages near {{organization|your shop}} show where demand will be this season.', '{{organization|आपकी दुकान}} के पास के गाँवों की जाँच बताती है कि इस मौसम माँग कहाँ होगी।') },
      { type: 'data', example: true, eyebrow: t('Within 20 km of your shop', 'आपकी दुकान से 20 किमी के भीतर'), title: t('Plots short of each nutrient', 'हर पोषक तत्व की कमी वाले खेत'),
        rows: [
          { label: t('Zinc sulphate', 'ज़िंक सल्फेट'), value: t('62% of plots', '62% खेत'), level: 1, status: t('High demand', 'ज़्यादा माँग') },
          { label: t('Gypsum (sulphur)', 'जिप्सम (सल्फ़र)'), value: t('41% of plots', '41% खेत'), level: 2, status: t('Rising', 'बढ़ती माँग') },
          { label: t('DAP', 'DAP'), value: t('18% of plots', '18% खेत'), level: 4, status: t('Lower than usual', 'सामान्य से कम') },
        ] },
      { type: 'cards', example: true, items: [
        { tag: t('For you', 'आपके लिए'), tag_tone: 'good', title: t('Earn on every test', 'हर जाँच पर कमाई'), text: t('Host a Soil Doctor kiosk and earn a share of every test.', 'Soil Doctor कियोस्क रखें और हर जाँच से हिस्सा कमाएँ।') },
        { tag: t('For farmers', 'किसानों के लिए'), tag_tone: 'info', title: t('Advice they trust', 'भरोसेमंद सलाह'), text: t('Sell against a dose card, not a guess.', 'अंदाज़े से नहीं, खुराक कार्ड के अनुसार बेचें।') },
      ] },
      { type: 'panel', eyebrow: t('Become a partner retailer', 'साझेदार विक्रेता बनें'), title: t('Put a clinic in your shop', 'अपनी दुकान में क्लिनिक लगाएँ'),
        text: t('Setup takes one visit. We train your staff and bring the farmers.', 'एक बार आने पर सेटअप। हम आपके स्टाफ़ को प्रशिक्षित करते हैं और किसानों को लाते हैं।'),
        button: { text: t('Talk to us →', 'हमसे बात करें →'), href: `${SITE}/retailers` } },
    ] },
  },
];

export const STARTER_BY_KEY = Object.fromEntries(STARTERS.map((s) => [s.key, s]));

export const CATEGORIES = {
  GENERAL: 'General', NEWSLETTER: 'Newsletter', GREETING: 'Greeting', ADVISORY: 'Advisory', REPORT: 'Report', PRODUCT: 'Product',
  FOLLOW_UP: 'Follow-up', EVENT: 'Event', INDUSTRY: 'Industry update', CAREERS: 'Careers', WELCOME: 'Welcome', REENGAGE: 'Re-engagement',
  STORY: 'Impact story', PARTNER: 'Partners', RETAIL: 'Retailers',
};
