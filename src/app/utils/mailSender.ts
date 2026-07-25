// import nodemailer from 'nodemailer';


// const isProduction = false;

// export const sendEmail = async (to: string, subject: string, html: string) => {

// const transporter = nodemailer.createTransport({
//   host: "smtp.hostinger.com", // sending SMTP server
//   port: isProduction ? 465 : 587,             // SSL port
//   secure: isProduction,           // true for port 465
//   auth: {
//     user: "info@engrosbasen.dk",        // webmail email
//     pass: "Engrosbasen2025@"   // SMTP/webmail password
//   },
//   tls: {
//       rejectUnauthorized: false // <-- add this
//     }
// });

  

//   try {
//      console.log('mail send started');
//     await transporter.sendMail({
//       from: `"Engrosbasen Team" <info@engrosbasen.dk>`, // sender address
//       to, // list of receivers
//       subject,
//       html, // html body
//     });

//     console.log('mail sended successfully');
    
//   } catch (error) {
//     console.log('send mail error:', error);
    
//   }
//   console.log('mail sended stopped');
// };



import nodemailer from 'nodemailer';
import config from '../config';


const isProduction = process.env.NODE_ENV === 'production';

export const sendEmail = async (to: string, subject: string, html: string) => {

const transporter = nodemailer.createTransport({
  host: config.smtp.host, // sending SMTP server
  port: 2525,             // SSL port
  secure: isProduction,           // true for port 465
  auth: {
    user: config.smtp.user,        // webmail email
    pass: config.smtp.pass   // SMTP/webmail password
  },
});


transporter.verify((err, success) => {
  if (err) {
    console.error('SMTP connection failed', err);
  } else {
    console.log('SMTP is ready to send mail');
  }
});  


  try {
     console.log('============== mail send started =======');
    await transporter.sendMail({
      from: `"${config.smtp.fromName || config.project_name}" <${config.noreply_email}>`,
      to,
      subject,
      html,
    });

    console.log('============== mail sended successfully ========= ');
    
  } catch (error) {
    console.log('send mail error:', error);
    
  }
  console.log('mail sended stopped');
};




// import nodemailer from 'nodemailer';
// import config from '../config';

// //  Hostinger business email 
// export const sendEmail = async (to: string, subject: string, html: string) => {
 
//   const transporter = nodemailer.createTransport({
//     host: 'smtp.gmail.com',
//     port: 587,
//     secure: config.NODE_ENV === 'production',
//     auth: {
//       // TODO: replace `user` and `pass` values from <https://forwardemail.net>
//       user: config.nodemailer_host_email,
//       pass: config.nodemailer_host_pass,
//     },
//   });

  

//   try {
//      console.log('mail send started');
//     await transporter.sendMail({
//       from: 'team.robust.dev@gmail.com', // sender address
//       to, // list of receivers
//       subject,
//       text: '', // plain text body
//       html, // html body
//     });

//     console.log('mail sended successfully');
    
//   } catch (error) {
//     console.log('send mail error:', error);
    
//   }
//   console.log('mail sended stopped');
// };

// export const sendEmail = async (to: string, subject: string, html: string) => {
 
//   const transporter = nodemailer.createTransport({
//     host: 'smtp.gmail.com',
//     port: 587,
//     secure: config.NODE_ENV === 'production',
//     auth: {
//       // TODO: replace `user` and `pass` values from <https://forwardemail.net>
//       user: config.nodemailer_host_email,
//       pass: config.nodemailer_host_pass,
//     },
//   });

  

//   try {
//      console.log('mail send started');
//     await transporter.sendMail({
//       from: 'team.robust.dev@gmail.com', // sender address
//       to, // list of receivers
//       subject,
//       text: '', // plain text body
//       html, // html body
//     });

//     console.log('mail sended successfully');
    
//   } catch (error) {
//     console.log('send mail error:', error);
    
//   }
//   console.log('mail sended stopped');
// };



















