import config from "../config";
import { sendEmail } from "./mailSender";

interface BookingNotificationEmailParams {
  sentTo: string;       // user email
  subject: string;      // email subject
  userName: string;     // sender name (service provider)
  messageText: string;  // main text
}

interface OtpSendEmailParams {
  sentTo: string;
  subject: string;
  name: string;
  otp: string | number;
  expiredAt: string;
}



const logoUrl      = config.logo_url      || 'https://i.ibb.co.com/HQj66GS/mino.png';
const mapUrl       = config.map_url       || 'https://i.ibb.co.com/RpXsvH7C/Mino-Map.png';
const primaryColor = config.primary_color || '#0A1A2F';
const supportEmail = config.support_email || 'support@gomino.co';
const billingEmail = config.billing_email || 'billing@gomino.co';
const driverEmail  = config.driver_email  || 'drivers@gomino.co';

const otpSendEmail = async ({
  sentTo,
  subject,
  name,
  otp,
  expiredAt,
}: OtpSendEmailParams): Promise<void> => {

  const otpExpiryMinutes = parseInt(config.otp_expire_time as string) || 2;
  
  const emailBody = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">

    <!-- Header -->
    <div style="background-color: ${primaryColor}; text-align: center; padding: 24px;">
      ${
        logoUrl
          ? `<img src="${logoUrl}" alt="${config.project_name} Logo" style="max-width: 150px; margin-bottom: 12px;" />`
          : ''
      }
      <h1 style="color: #ffffff; margin: 0; font-size: 22px;">
        One-Time Password (OTP)
      </h1>
    </div>

    <!-- Body -->
    <div style="padding: 24px; color: #333333;">
      <p>Hello <strong>${name}</strong>,</p>

      <br/>
      <p>
        Use the following One-Time Password (OTP) to complete your verification.
        This code is valid for a limited time.
      </p>

      <div style="
        background-color: #f4f6fb;
        border: 1px dashed ${primaryColor};
        padding: 20px;
        text-align: center;
        border-radius: 6px;
        margin: 24px 0;
      ">
        <p style="margin: 0; font-size: 14px; color: #555;">Your OTP Code</p>
        <p style="
          margin: 8px 0 0;
          font-size: 28px;
          font-weight: bold;
          color: ${primaryColor};
          letter-spacing: 4px;
        ">
          ${otp}
        </p>
      </div>


      <p style="font-size: 14px; color: #666;">
        This OTP will expire in <strong>${otpExpiryMinutes} minute${otpExpiryMinutes === 1 ? '' : 's'}</strong>.
      </p>

      <p style="margin-top: 24px; font-size: 14px;">
        If you didn’t request this code, please contact us at
        <a href="mailto:${supportEmail}" style="color: ${primaryColor}; text-decoration: none;">
          ${supportEmail}
        </a>.
      </p>

      <p style="margin-top: 32px;">
        Regards,<br />
        <strong>${config.project_name} Team</strong>
      </p>
    </div>

    <!-- Footer -->
    <div style="background-color: #f5f5f5; text-align: center; padding: 14px; font-size: 12px; color: #777;">
      <p style="margin: 0 0 6px;">Please do not reply to this email. For help, contact
        <a href="mailto:${supportEmail}" style="color: #555;">${supportEmail}</a>.
      </p>
      © ${new Date().getFullYear()} ${config.project_name}. All rights reserved.
    </div>
  </div>
  `;

  await sendEmail(sentTo, subject, emailBody);
};

const sendNotificationEmail = async ({
  sentTo,
  subject,
  userName,
  messageText,
}: BookingNotificationEmailParams): Promise<void> => {
  const emailBody = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">

    <!-- Header -->
    <div style="background-color: ${primaryColor}; text-align: center; padding: 20px;">
      ${
        logoUrl
          ? `<img src="${logoUrl}" alt="${config.project_name} Logo" style="max-width: 140px; margin-bottom: 10px;" />`
          : ''
      }
      <h1 style="color: #ffffff; margin: 0; font-size: 20px;">
        ${subject}
      </h1>
    </div>

    <!-- Body -->
    <div style="padding: 24px; color: #333333;">
      <p>Hello <strong>${userName}</strong>,</p>

      <p style="font-size: 16px; line-height: 1.6;">
        ${messageText}
      </p>

      <p style="margin-top: 24px; font-size: 14px; color: #666;">
        If you have any questions, feel free to contact us at
        <a href="mailto:${supportEmail}" style="color: ${primaryColor}; text-decoration: none;">
          ${supportEmail}
        </a>.
      </p>

      <p style="margin-top: 32px;">
        Best regards,<br />
        <strong>${config.project_name} Team</strong>
      </p>
    </div>

    <!-- Footer -->
    <div style="background-color: #f5f5f5; text-align: center; padding: 14px; font-size: 12px; color: #777;">
      <p style="margin: 0 0 6px;">Please do not reply to this email. For help, contact
        <a href="mailto:${supportEmail}" style="color: #555;">${supportEmail}</a>.
      </p>
      © ${new Date().getFullYear()} ${config.project_name}. All rights reserved.
    </div>
  </div>
  `;

  await sendEmail(sentTo, subject, emailBody);
};





// ============================================================
// RIDE COMPLETED EMAIL
// ============================================================

interface RideCompletedEmailParams {
  sentTo: string;
  subject: string;

  passengerName: string;
  rideId: string;

  date: string;

  pickupAddress: string;
  dropoffAddress: string;

  pickupTime?: string;
  dropoffTime?: string;

  totalFare: number;
  subtotal?: number;
  vat?: number;
  discount?: number;
  platformCommission?: number;

  paymentMethod: string;

  distanceKm?: number;
  durationMin?: number;

  mapImage?: string;
}

const rideCompletedEmailTemplate = async ({
  sentTo,
  subject,

  passengerName,
  rideId,

  date,

  pickupAddress,
  dropoffAddress,

  pickupTime,
  dropoffTime,

  totalFare,
  subtotal,
  vat,
  discount,
  platformCommission,

  paymentMethod,

  distanceKm,
  durationMin,

  mapImage,
}: RideCompletedEmailParams): Promise<void> => {
  const emailBody = `
  <div style="
    margin:0;
    padding:0;
    background:#0f1115;
    font-family:Arial,sans-serif;
    color:#ffffff;
  ">

    <table width="100%" cellpadding="0" cellspacing="0"
      style="padding:30px 15px;background:#0f1115;">
      <tr>
        <td align="center">

          <table width="100%" cellpadding="0" cellspacing="0"
            style="
              max-width:600px;
              background:#181c23;
              border-radius:18px;
              overflow:hidden;
            ">

            <!-- HEADER -->
            <tr>
              <td style="
                background:${primaryColor};
                padding:30px 25px;
                text-align:center;
              ">
                ${
                  logoUrl
                    ? `
                  <img
                    src="${logoUrl}"
                    alt="${config.project_name}"
                    style="
                      max-width:120px;
                      margin-bottom:16px;
                    "
                  />
                `
                    : ''
                }

                <h1 style="
                  margin:0;
                  font-size:28px;
                  color:#ffffff;
                ">
                  Ride Completed
                </h1>

                <p style="
                  margin-top:10px;
                  color:#d9f8eb;
                  font-size:14px;
                ">
                  Thank you for riding with us
                </p>
              </td>
            </tr>

            <!-- BODY -->
            <tr>
              <td style="padding:35px 30px 10px;">

                <h2 style="
                  margin:0;
                  font-size:30px;
                  color:#ffffff;
                ">
                  Thanks for riding with us,
                </h2>

                <p style="
                  margin-top:10px;
                  font-size:26px;
                  font-weight:bold;
                  color:${primaryColor};
                ">
                  ${passengerName}
                </p>

                <p style="
                  margin-top:18px;
                  font-size:15px;
                  line-height:24px;
                  color:#c7c7c7;
                ">
                  We hope you enjoyed your ride.
                  Below is your ride receipt and trip details.
                </p>

              </td>
            </tr>

            <!-- TOTAL -->
            <tr>
              <td style="padding:10px 30px 0;">

                <table width="100%" cellpadding="0" cellspacing="0"
                  style="
                    background:#11151b;
                    border-radius:14px;
                    padding:25px;
                  ">

                  <tr>
                    <td>
                      <p style="
                        margin:0;
                        color:#9aa4af;
                        font-size:14px;
                      ">
                        Total Charged
                      </p>

                      <h1 style="
                        margin:8px 0 0;
                        font-size:42px;
                        color:#ffffff;
                      ">
                        €${totalFare.toFixed(2)}
                      </h1>
                    </td>

                    <td align="right">
                      <div style="
                        background:${primaryColor};
                        color:#ffffff;
                        padding:10px 18px;
                        border-radius:30px;
                        font-size:14px;
                        font-weight:bold;
                        display:inline-block;
                      ">
                        ${paymentMethod}
                      </div>
                    </td>
                  </tr>

                </table>

              </td>
            </tr>

            <!-- FARE DETAILS -->
            <tr>
              <td style="padding:25px 30px 0;">

                <table width="100%" cellpadding="0" cellspacing="0"
                  style="
                    background:#11151b;
                    border-radius:14px;
                    padding:25px;
                  ">

                  <tr>
                    <td colspan="2">
                      <h3 style="
                        margin:0 0 20px;
                        color:#ffffff;
                        font-size:22px;
                      ">
                        Fare Details
                      </h3>
                    </td>
                  </tr>

                  ${
                    subtotal
                      ? `
                    <tr>
                      <td style="padding:8px 0;color:#b9c0c7;">
                        Subtotal
                      </td>

                      <td align="right" style="padding:8px 0;color:#ffffff;">
                        €${subtotal.toFixed(2)}
                      </td>
                    </tr>
                  `
                      : ''
                  }

                  ${
                    vat
                      ? `
                    <tr>
                      <td style="padding:8px 0;color:#b9c0c7;">
                        VAT
                      </td>

                      <td align="right" style="padding:8px 0;color:#ffffff;">
                        €${vat.toFixed(2)}
                      </td>
                    </tr>
                  `
                      : ''
                  }

                  ${
                    discount
                      ? `
                    <tr>
                      <td style="padding:8px 0;color:#b9c0c7;">
                        Discount
                      </td>

                      <td align="right" style="padding:8px 0;color:#00d26a;">
                        -€${discount.toFixed(2)}
                      </td>
                    </tr>
                  `
                      : ''
                  }

                  ${
                    platformCommission
                      ? `
                    <tr>
                      <td style="padding:8px 0;color:#b9c0c7;">
                        Platform Commission
                      </td>

                      <td align="right" style="padding:8px 0;color:#ff9f43;">
                        €${platformCommission.toFixed(2)}
                      </td>
                    </tr>
                  `
                      : ''
                  }

                  <tr>
                    <td colspan="2">
                      <hr style="
                        border:none;
                        border-top:1px solid #2a2f38;
                        margin:16px 0;
                      ">
                    </td>
                  </tr>

                  <tr>
                    <td style="
                      padding:6px 0;
                      color:#ffffff;
                      font-size:18px;
                      font-weight:bold;
                    ">
                      Total
                    </td>

                    <td align="right" style="
                      padding:6px 0;
                      color:#ffffff;
                      font-size:18px;
                      font-weight:bold;
                    ">
                      €${totalFare.toFixed(2)}
                    </td>
                  </tr>

                </table>

              </td>
            </tr>

            <!-- RIDE DETAILS -->
            <tr>
              <td style="padding:25px 30px 0;">

                <table width="100%" cellpadding="0" cellspacing="0"
                  style="
                    background:#11151b;
                    border-radius:14px;
                    padding:25px;
                  ">

                  <tr>
                    <td colspan="2">
                      <h3 style="
                        margin:0 0 20px;
                        color:#ffffff;
                        font-size:22px;
                      ">
                        Ride Details
                      </h3>
                    </td>
                  </tr>

                  <tr>
                    <td style="
                      padding:10px 0;
                      color:#9aa4af;
                      width:140px;
                    ">
                      Ride ID
                    </td>

                    <td style="padding:10px 0;color:#ffffff;">
                      ${rideId}
                    </td>
                  </tr>

                  <tr>
                    <td style="padding:10px 0;color:#9aa4af;">
                      Date
                    </td>

                    <td style="padding:10px 0;color:#ffffff;">
                      ${date}
                    </td>
                  </tr>

                  ${
                    distanceKm
                      ? `
                    <tr>
                      <td style="padding:10px 0;color:#9aa4af;">
                        Distance
                      </td>

                      <td style="padding:10px 0;color:#ffffff;">
                        ${distanceKm} km
                      </td>
                    </tr>
                  `
                      : ''
                  }

                  ${
                    durationMin
                      ? `
                    <tr>
                      <td style="padding:10px 0;color:#9aa4af;">
                        Duration
                      </td>

                      <td style="padding:10px 0;color:#ffffff;">
                        ${durationMin} mins
                      </td>
                    </tr>
                  `
                      : ''
                  }

                </table>

              </td>
            </tr>

            ${
              mapUrl
                ? `
              <tr>
                <td style="padding:25px 30px 0;">
                  <img
                    src="${mapUrl}"
                    alt="Map"
                    width="100%"
                    style="
                      border-radius:14px;
                      display:block;
                    "
                  />
                </td>
              </tr>
            `
                : ''
            }

            <!-- ROUTE -->
            <tr>
              <td style="padding:25px 30px 35px;">

                <table width="100%" cellpadding="0" cellspacing="0"
                  style="
                    background:#11151b;
                    border-radius:14px;
                    padding:25px;
                  ">

                  <tr>
                    <td colspan="2">
                      <h3 style="
                        margin:0 0 20px;
                        color:#ffffff;
                        font-size:22px;
                      ">
                        Trip Route
                      </h3>
                    </td>
                  </tr>

                  <!-- PICKUP -->
                  <tr>
                    <td valign="top" width="30">
                      <div style="
                        width:14px;
                        height:14px;
                        border-radius:50%;
                        background:#00d26a;
                        margin-top:6px;
                      "></div>
                    </td>

                    <td style="padding-bottom:25px;">

                      <p style="
                        margin:0;
                        color:#9aa4af;
                        font-size:13px;
                      ">
                        PICKUP
                      </p>

                      <p style="
                        margin:6px 0 0;
                        color:#ffffff;
                        font-size:16px;
                        line-height:24px;
                      ">
                        ${pickupAddress}
                      </p>

                      ${
                        pickupTime
                          ? `
                        <p style="
                          margin-top:6px;
                          color:#00d26a;
                          font-size:14px;
                        ">
                          ${pickupTime}
                        </p>
                      `
                          : ''
                      }

                    </td>
                  </tr>

                  <!-- DROPOFF -->
                  <tr>
                    <td valign="top" width="30">
                      <div style="
                        width:14px;
                        height:14px;
                        border-radius:50%;
                        background:#ff4d4f;
                        margin-top:6px;
                      "></div>
                    </td>

                    <td>

                      <p style="
                        margin:0;
                        color:#9aa4af;
                        font-size:13px;
                      ">
                        DROPOFF
                      </p>

                      <p style="
                        margin:6px 0 0;
                        color:#ffffff;
                        font-size:16px;
                        line-height:24px;
                      ">
                        ${dropoffAddress}
                      </p>

                      ${
                        dropoffTime
                          ? `
                        <p style="
                          margin-top:6px;
                          color:#ff4d4f;
                          font-size:14px;
                        ">
                          ${dropoffTime}
                        </p>
                      `
                          : ''
                      }

                    </td>
                  </tr>

                </table>

              </td>
            </tr>

            <!-- FOOTER -->
            <tr>
              <td style="
                padding:25px;
                text-align:center;
                background:#12161c;
              ">

                <p style="
                  margin:0;
                  color:#8b949e;
                  font-size:13px;
                  line-height:22px;
                ">
                  Thank you for choosing ${config.project_name}.<br/>
                  Safe travels and we look forward to riding with you again.
                </p>

                <p style="
                  margin-top:12px;
                  color:#8b949e;
                  font-size:12px;
                  line-height:20px;
                ">
                  For billing or payment questions, contact us at
                  <a href="mailto:${billingEmail}" style="color:#8b949e;">${billingEmail}</a>.<br/>
                  For general support, reach us at
                  <a href="mailto:${supportEmail}" style="color:#8b949e;">${supportEmail}</a>.
                </p>

                <p style="
                  margin-top:10px;
                  color:#5f6b76;
                  font-size:11px;
                ">
                  Please do not reply to this email.
                </p>

                <p style="
                  margin-top:15px;
                  color:#5f6b76;
                  font-size:12px;
                ">
                  © ${new Date().getFullYear()}
                  ${config.project_name}.
                  All rights reserved.
                </p>

              </td>
            </tr>

          </table>

        </td>
      </tr>
    </table>

  </div>
  `;

  await sendEmail(sentTo, subject, emailBody);
};

export {
  otpSendEmail,
  sendNotificationEmail,
  rideCompletedEmailTemplate,
};


