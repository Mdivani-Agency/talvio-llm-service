/*
 * Synthetic people for the evaluation set (MDI-223, design §14). Every name, employer, school,
 * contact and number below is invented; no customer document is used or needed. Phone numbers use
 * reserved fictional ranges and e-mail addresses use the example.* domains.
 */

export type When = { year: number; month: number | null };

export type Role = {
  company: string;
  jobTitle: string;
  start: When | null;
  end: When | 'present' | null;
  bullets: string[];
};

export type School = { institution: string; degree: string; start: number; end: number };

export type Proficiency = 'native' | 'fluent' | 'intermediate' | 'beginner';

export type Persona = {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
  email: string;
  phone: string;
  city: string;
  country: string;
  summary: string;
  roles: Role[];
  schools: School[];
  skills: string[];
  languages: { language: string; proficiency: Proficiency }[];
  /** Written in Georgian: headings, names and the words for "present" and proficiency. */
  georgian?: true;
};

const at = (year: number, month: number | null = null): When => ({ year, month });

export const PERSONAS: Persona[] = [
  {
    id: 'p01',
    firstName: 'Mariam',
    lastName: 'Kvaratskhelia',
    role: 'Senior Backend Engineer',
    email: 'mariam.k@example.com',
    phone: '+995 555 010 101',
    city: 'Tbilisi',
    country: 'Georgia',
    summary: 'Backend engineer focused on payment systems and reliable data pipelines.',
    roles: [
      {
        company: 'Lumen Payments',
        jobTitle: 'Senior Backend Engineer',
        start: at(2021, 3),
        end: 'present',
        bullets: [
          'Cut settlement latency by 40% by redesigning the ledger service',
          'Led the migration of 12 services to PostgreSQL 15',
        ],
      },
      {
        company: 'Orbit Retail',
        jobTitle: 'Backend Engineer',
        start: at(2017, 9),
        end: at(2021, 2),
        bullets: ['Built the order export used by 300 merchants'],
      },
    ],
    schools: [
      {
        institution: 'Caucasus Technical University',
        degree: 'BSc Computer Science',
        start: 2013,
        end: 2017,
      },
    ],
    skills: ['TypeScript', 'PostgreSQL', 'AWS', 'Kafka'],
    languages: [
      { language: 'Georgian', proficiency: 'native' },
      { language: 'English', proficiency: 'fluent' },
    ],
  },
  {
    id: 'p02',
    firstName: 'Daniel',
    lastName: 'Okafor',
    role: 'Data Analyst',
    email: 'd.okafor@example.org',
    phone: '+44 7700 900123',
    city: 'Manchester',
    country: 'United Kingdom',
    summary: 'Analyst who turns messy operational data into weekly decisions for retail teams.',
    roles: [
      {
        company: 'Brightway Groceries',
        jobTitle: 'Data Analyst',
        start: at(2020, 6),
        end: 'present',
        bullets: [
          'Built a demand dashboard used by 45 store managers',
          'Reduced weekly reporting time from two days to three hours',
        ],
      },
      {
        company: 'Halden Insurance',
        jobTitle: 'Junior Analyst',
        start: at(2018, 1),
        end: at(2020, 5),
        bullets: ['Maintained claims reports in SQL and Excel'],
      },
    ],
    schools: [
      {
        institution: 'University of Northfield',
        degree: 'BSc Mathematics',
        start: 2014,
        end: 2017,
      },
    ],
    skills: ['SQL', 'Python', 'Tableau', 'Excel'],
    languages: [{ language: 'English', proficiency: 'native' }],
  },
  {
    id: 'p03',
    firstName: 'Sofia',
    lastName: 'Marchetti',
    role: 'Product Designer',
    email: 'sofia.marchetti@example.net',
    phone: '+39 0212 345678',
    city: 'Milan',
    country: 'Italy',
    summary: 'Product designer for mobile banking, from research to shipped interfaces.',
    roles: [
      {
        company: 'Vela Bank',
        jobTitle: 'Senior Product Designer',
        start: at(2022, 1),
        end: 'present',
        bullets: [
          'Redesigned onboarding and raised completion from 52% to 71%',
          'Ran 30 usability sessions per quarter',
        ],
      },
      {
        company: 'Studio Ardesia',
        jobTitle: 'UX Designer',
        start: at(2018, 4),
        end: at(2021, 12),
        bullets: ['Designed booking flows for 8 hospitality clients'],
      },
    ],
    schools: [
      {
        institution: 'Politecnico di Lumiere',
        degree: 'MA Interaction Design',
        start: 2016,
        end: 2018,
      },
    ],
    skills: ['Figma', 'User Research', 'Prototyping', 'Design Systems'],
    languages: [
      { language: 'Italian', proficiency: 'native' },
      { language: 'English', proficiency: 'fluent' },
    ],
  },
  {
    id: 'p04',
    firstName: 'Lucas',
    lastName: 'Ferreira',
    role: 'DevOps Engineer',
    email: 'lucas.ferreira@example.com',
    phone: '+351 210 000 456',
    city: 'Lisbon',
    country: 'Portugal',
    summary: 'Platform engineer who keeps deploys boring and on-call quiet.',
    roles: [
      {
        company: 'Tidewater Logistics',
        jobTitle: 'DevOps Engineer',
        start: at(2019, 7),
        end: 'present',
        bullets: [
          'Moved 60 services to Terraform-managed infrastructure',
          'Cut monthly cloud spend by 18%',
        ],
      },
      {
        company: 'Cobalt Hosting',
        jobTitle: 'Systems Administrator',
        start: at(2015, 2),
        end: at(2019, 6),
        bullets: ['Ran a fleet of 400 Linux servers'],
      },
    ],
    schools: [
      {
        institution: 'Instituto Superior de Atlantis',
        degree: 'BSc Informatics',
        start: 2011,
        end: 2015,
      },
    ],
    skills: ['Terraform', 'AWS', 'Linux', 'Docker'],
    languages: [
      { language: 'Portuguese', proficiency: 'native' },
      { language: 'English', proficiency: 'fluent' },
      { language: 'Spanish', proficiency: 'intermediate' },
    ],
  },
  {
    id: 'p05',
    firstName: 'Aiko',
    lastName: 'Tanabe',
    role: 'Marketing Manager',
    email: 'aiko.tanabe@example.org',
    phone: '+81 3 5555 0199',
    city: 'Osaka',
    country: 'Japan',
    summary: 'Marketing manager for subscription products in Asian markets.',
    roles: [
      {
        company: 'Kiriko Media',
        jobTitle: 'Marketing Manager',
        start: at(2020, 10),
        end: 'present',
        bullets: ['Grew paid subscribers by 35% in two years', 'Managed a team of 6 marketers'],
      },
      {
        company: 'Hoshi Beverages',
        jobTitle: 'Brand Specialist',
        start: at(2016, 4),
        end: at(2020, 9),
        bullets: ['Launched 4 seasonal product campaigns'],
      },
    ],
    schools: [
      {
        institution: 'Kansai Institute of Commerce',
        degree: 'BA Marketing',
        start: 2012,
        end: 2016,
      },
    ],
    skills: ['Campaign Planning', 'Google Analytics', 'Copywriting', 'CRM'],
    languages: [
      { language: 'Japanese', proficiency: 'native' },
      { language: 'English', proficiency: 'fluent' },
    ],
  },
  {
    id: 'p06',
    firstName: 'Elena',
    lastName: 'Popescu',
    role: 'Accountant',
    email: 'elena.popescu@example.net',
    phone: '+40 21 000 7788',
    city: 'Cluj-Napoca',
    country: 'Romania',
    summary: 'Chartered accountant for mid-size manufacturing companies.',
    roles: [
      {
        company: 'Carpathia Steelworks',
        jobTitle: 'Senior Accountant',
        start: at(2019, 1),
        end: 'present',
        bullets: [
          'Closed the monthly books in 5 working days instead of 9',
          'Prepared statutory accounts for 3 subsidiaries',
        ],
      },
      {
        company: 'Danube Audit Partners',
        jobTitle: 'Audit Associate',
        start: at(2015, 9),
        end: at(2018, 12),
        bullets: ['Audited 20 manufacturing clients'],
      },
    ],
    schools: [
      {
        institution: 'Academy of Economic Studies Cluj',
        degree: 'BSc Accounting',
        start: 2011,
        end: 2015,
      },
    ],
    skills: ['IFRS', 'SAP', 'Financial Reporting', 'Excel'],
    languages: [
      { language: 'Romanian', proficiency: 'native' },
      { language: 'English', proficiency: 'fluent' },
      { language: 'French', proficiency: 'beginner' },
    ],
  },
  {
    id: 'p07',
    firstName: 'Omar',
    lastName: 'Haddad',
    role: 'Registered Nurse',
    email: 'omar.haddad@example.com',
    phone: '+1 555 0142',
    city: 'Toronto',
    country: 'Canada',
    summary: 'Critical care nurse with experience training new staff.',
    roles: [
      {
        company: 'Lakeshore General Hospital',
        jobTitle: 'Registered Nurse, ICU',
        start: at(2018, 5),
        end: 'present',
        bullets: [
          'Precepted 14 newly qualified nurses',
          'Coordinated care for up to 4 ventilated patients per shift',
        ],
      },
      {
        company: 'Maple Community Clinic',
        jobTitle: 'Staff Nurse',
        start: at(2015, 8),
        end: at(2018, 4),
        bullets: ['Ran the weekly vaccination clinic'],
      },
    ],
    schools: [
      {
        institution: 'Northbridge School of Nursing',
        degree: 'Bachelor of Science in Nursing',
        start: 2011,
        end: 2015,
      },
    ],
    skills: ['Critical Care', 'Patient Assessment', 'BLS', 'ACLS'],
    languages: [
      { language: 'English', proficiency: 'fluent' },
      { language: 'Arabic', proficiency: 'native' },
    ],
  },
  {
    id: 'p08',
    firstName: 'Hannah',
    lastName: 'Lindqvist',
    role: 'Mathematics Teacher',
    email: 'hannah.lindqvist@example.org',
    phone: '+46 8 555 010 20',
    city: 'Uppsala',
    country: 'Sweden',
    summary: 'Secondary school mathematics teacher and exam coordinator.',
    roles: [
      {
        company: 'Fyris Upper Secondary School',
        jobTitle: 'Mathematics Teacher',
        start: at(2016, 8),
        end: 'present',
        bullets: [
          'Raised the national exam pass rate from 78% to 90%',
          'Coordinated exams for 240 students each year',
        ],
      },
      {
        company: 'Granberg Learning Centre',
        jobTitle: 'Tutor',
        start: at(2013, null),
        end: at(2016, null),
        bullets: ['Tutored 25 students a term in algebra and statistics'],
      },
    ],
    schools: [
      {
        institution: 'Uppsala College of Education',
        degree: 'Master of Education',
        start: 2011,
        end: 2016,
      },
    ],
    skills: ['Curriculum Design', 'Statistics', 'Classroom Management', 'GeoGebra'],
    languages: [
      { language: 'Swedish', proficiency: 'native' },
      { language: 'English', proficiency: 'fluent' },
      { language: 'German', proficiency: 'intermediate' },
    ],
  },
  {
    id: 'p09',
    firstName: 'Tomasz',
    lastName: 'Wójcik',
    role: 'Mobile Developer',
    email: 'tomasz.wojcik@example.com',
    phone: '+48 22 555 01 33',
    city: 'Kraków',
    country: 'Poland',
    summary: 'Mobile developer shipping fitness and health apps on iOS and Android.',
    roles: [
      {
        company: 'Pulsefit Apps',
        jobTitle: 'Senior Mobile Developer',
        start: at(2021, 6),
        end: 'present',
        bullets: [
          'Shipped a Kotlin Multiplatform rewrite to 1.2 million users',
          'Brought crash-free sessions to 99.8%',
        ],
      },
      {
        company: 'Wisła Software House',
        jobTitle: 'iOS Developer',
        start: at(2017, 3),
        end: at(2021, 5),
        bullets: ['Built 9 client apps in Swift'],
      },
    ],
    schools: [
      {
        institution: 'Vistula University of Technology',
        degree: 'MSc Computer Science',
        start: 2012,
        end: 2017,
      },
    ],
    skills: ['Swift', 'Kotlin', 'Kotlin Multiplatform', 'Firebase'],
    languages: [
      { language: 'Polish', proficiency: 'native' },
      { language: 'English', proficiency: 'fluent' },
    ],
  },
  {
    id: 'p10',
    firstName: 'Priya',
    lastName: 'Raman',
    role: 'Project Manager',
    email: 'priya.raman@example.net',
    phone: '+91 22 5555 0170',
    city: 'Pune',
    country: 'India',
    summary: 'Delivery-focused project manager for enterprise software rollouts.',
    roles: [
      {
        company: 'Indus Systems',
        jobTitle: 'Project Manager',
        start: at(2019, 4),
        end: 'present',
        bullets: ['Delivered 7 ERP rollouts on schedule', 'Managed budgets of up to USD 2 million'],
      },
      {
        company: 'Deccan Consulting',
        jobTitle: 'Business Analyst',
        start: at(2015, 7),
        end: at(2019, 3),
        bullets: ['Wrote requirements for 11 banking projects'],
      },
    ],
    schools: [
      {
        institution: 'Western India Institute of Management',
        degree: 'MBA',
        start: 2013,
        end: 2015,
      },
    ],
    skills: ['Agile', 'Jira', 'Stakeholder Management', 'Risk Management'],
    languages: [
      { language: 'Hindi', proficiency: 'native' },
      { language: 'English', proficiency: 'fluent' },
      { language: 'Marathi', proficiency: 'fluent' },
    ],
  },
  {
    id: 'p11',
    georgian: true,
    firstName: 'ნინო',
    lastName: 'ბერიძე',
    role: 'უფროსი პროგრამისტი',
    email: 'nino.beridze@example.com',
    phone: '+995 555 020 202',
    city: 'ბათუმი',
    country: 'საქართველო',
    summary: 'პროგრამისტი, რომელიც ქმნის გადახდების და ლოგისტიკის სერვისებს.',
    roles: [
      {
        company: 'შპს „ზღვისპირა ლოჯისტიკა“',
        jobTitle: 'უფროსი პროგრამისტი',
        start: at(2020, 2),
        end: 'present',
        bullets: [
          'შექმნა ტვირთების თვალყურის დევნების სერვისი 50 კლიენტისთვის',
          'შეამცირა სერვერის ხარჯი 25%-ით',
        ],
      },
      {
        company: 'შპს „ციფრული ხიდი“',
        jobTitle: 'პროგრამისტი',
        start: at(2016, 9),
        end: at(2020, 1),
        bullets: ['მხარს უჭერდა გადახდების API-ს'],
      },
    ],
    schools: [
      {
        institution: 'შავი ზღვის ტექნიკური უნივერსიტეტი',
        degree: 'კომპიუტერული მეცნიერების ბაკალავრი',
        start: 2012,
        end: 2016,
      },
    ],
    skills: ['Go', 'PostgreSQL', 'Docker', 'gRPC'],
    languages: [
      { language: 'ქართული', proficiency: 'native' },
      { language: 'ინგლისური', proficiency: 'fluent' },
    ],
  },
  {
    id: 'p12',
    georgian: true,
    firstName: 'გიორგი',
    lastName: 'ლომიძე',
    role: 'მონაცემთა ანალიტიკოსი',
    email: 'g.lomidze@example.org',
    phone: '+995 555 030 303',
    city: 'ქუთაისი',
    country: 'საქართველო',
    summary: 'ანალიტიკოსი საცალო ვაჭრობის და ფინანსების მონაცემებით.',
    roles: [
      {
        company: 'შპს „იმერეთის ბაზარი“',
        jobTitle: 'მონაცემთა ანალიტიკოსი',
        start: at(2019, 5),
        end: 'present',
        bullets: [
          'ააწყო გაყიდვების ანგარიშგება 30 მაღაზიისთვის',
          'ყოველკვირეული ანგარიშის მომზადება 2 დღიდან 4 საათამდე შეამცირა',
        ],
      },
    ],
    schools: [
      {
        institution: 'რიონის სახელმწიფო უნივერსიტეტი',
        degree: 'მათემატიკის ბაკალავრი',
        start: 2014,
        end: 2018,
      },
    ],
    skills: ['SQL', 'Power BI', 'Python', 'Excel'],
    languages: [
      { language: 'ქართული', proficiency: 'native' },
      { language: 'ინგლისური', proficiency: 'intermediate' },
      { language: 'რუსული', proficiency: 'intermediate' },
    ],
  },
];
