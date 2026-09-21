import { z } from 'zod';

const userValidationSchema = z.object({
  body: z.object({
    name: z
      .string()
      .min(1, { message: 'Full name is required' })
      .optional(),

    email: z
      .string()
      .email({ message: 'Invalid email format' })
      .toLowerCase(),

    password: z
      .string()
      .min(6, { message: 'Password must be at least 6 characters long' }),

    role: z.enum(['admin', 'passenger', 'driver'], {
      errorMap: () => ({ message: 'Role must be admin, passenger, or driver' }),
    }),

    countryCode: z
      .string(),

    phoneNumber: z
      .string()
      .regex(/^[0-9]{6,15}$/, {
        message: 'Phone number must contain 6 to 15 digits',
      }),

    gender: z
      .enum(['male', 'female', 'other'])
      .optional(),

    dateOfBirth: z
      .string()
      .optional()
      .refine((date) => {
        if (!date) return true;
        return !isNaN(Date.parse(date));
      }, { message: 'Invalid date format. Use YYYY-MM-DD' }),

    acceptTerms: z
      .boolean({
        required_error: 'You must accept terms and conditions',
      })
      .refine((val) => val === true, {
        message: 'You must accept terms and conditions',
      }),
  }),
});

const addEmergencyContactSchema = z.object({
  body: z.object({
    name: z.string().min(1, { message: 'Name is required' }),
    phoneNumber: z.string().regex(/^[0-9]{6,15}$/, {
      message: 'Phone number must contain 6 to 15 digits',
    }),
  }),
});

const updateEmergencyContactSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    countryCode: z.string().min(1).optional(),
    phoneNumber: z.string().regex(/^[0-9]{6,15}$/, {
      message: 'Phone number must contain 6 to 15 digits',
    }).optional(),
  }),
});

const approveDriverSchema = z.object({
  body: z.object({
    vehicleTypes: z
      .array(z.enum(['MINO_GO', 'MINO_COMFORT', 'MINO_XL', 'MINO_MOTO']))
      .min(1, { message: 'Select at least one vehicle type' }),
  }),
});

export const userValidation = {
  userValidationSchema,
  addEmergencyContactSchema,
  updateEmergencyContactSchema,
  approveDriverSchema,
};
