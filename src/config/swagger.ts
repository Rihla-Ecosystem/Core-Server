import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Core Server API',
      version: '0.1.0',
      description: 'ITI Hub — Authentication, User Management, XP & Badges System',
    },
    servers: [{ url: '/api', description: 'API base path' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            details: {
              type: 'array',
              items: { type: 'object' },
              description: 'Validation error details (Zod)',
            },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            displayName: { type: 'string' },
            avatarUrl: { type: 'string', nullable: true },
            bio: { type: 'string', nullable: true },
            gender: { type: 'string', enum: ['MALE', 'FEMALE'] },
            nationality: { type: 'string' },
            language: { type: 'array', items: { type: 'string' } },
            budgetLevel: { type: 'string', nullable: true },
            arrivalDate: { type: 'string', format: 'date', nullable: true },
            departureDate: { type: 'string', format: 'date', nullable: true },
            travelStyle: { type: 'string', nullable: true },
            interests: { type: 'array', items: { type: 'string' }, nullable: true },
            accommodationType: { type: 'string', nullable: true },
            roleId: { type: 'integer' },
            isEmailVerified: { type: 'boolean' },
            xp: { type: 'integer' },
            level: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
            role: {
              type: 'object',
              properties: { name: { type: 'string' } },
            },
          },
        },
        LoginResponse: {
          type: 'object',
          properties: {
            accessToken: { type: 'string' },
            user: { $ref: '#/components/schemas/User' },
          },
        },
        RegisterInput: {
          type: 'object',
          required: ['email', 'password', 'display_name', 'gender', 'nationality', 'language'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8, description: 'At least 1 uppercase + 1 number' },
            display_name: { type: 'string', minLength: 1, maxLength: 100 },
            gender: { type: 'string', enum: ['MALE', 'FEMALE'] },
            nationality: { type: 'string', minLength: 1, maxLength: 100 },
            language: { type: 'array', items: { type: 'string' }, minItems: 1 },
            budget_level: { type: 'string', maxLength: 50 },
            arrival_date: { type: 'string', format: 'date-time' },
            departure_date: { type: 'string', format: 'date-time' },
            travel_style: { type: 'string', maxLength: 50 },
            interests: { type: 'array', items: { type: 'string' } },
            accommodation_type: { type: 'string', maxLength: 50 },
          },
        },
        LoginInput: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
          },
        },
        EmailInput: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', format: 'email' } },
        },
        ResetPasswordInput: {
          type: 'object',
          required: ['token', 'new_password'],
          properties: {
            token: { type: 'string' },
            new_password: { type: 'string', minLength: 8 },
          },
        },
        UpdateProfileInput: {
          type: 'object',
          properties: {
            display_name: { type: 'string', maxLength: 100 },
            avatar_url: { type: 'string', format: 'uri' },
            bio: { type: 'string', maxLength: 500 },
            gender: { type: 'string', enum: ['MALE', 'FEMALE'] },
            nationality: { type: 'string', minLength: 1, maxLength: 100 },
            language: { type: 'array', items: { type: 'string' } },
            budget_level: { type: 'string', maxLength: 50 },
            arrival_date: { type: 'string', format: 'date-time' },
            departure_date: { type: 'string', format: 'date-time' },
            travel_style: { type: 'string', maxLength: 50 },
            interests: { type: 'array', items: { type: 'string' } },
            accommodation_type: { type: 'string', maxLength: 50 },
          },
        },
        UpdateRoleInput: {
          type: 'object',
          required: ['role_id'],
          properties: { role_id: { type: 'integer' } },
        },
        Badge: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            description: { type: 'string' },
            iconUrl: { type: 'string', nullable: true },
            criteriaType: { type: 'string' },
            criteriaValue: { type: 'integer', nullable: true },
          },
        },
        AuditLog: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            actorId: { type: 'string', format: 'uuid', nullable: true },
            action: { type: 'string' },
            targetUserId: { type: 'string', format: 'uuid', nullable: true },
            metadata: { type: 'object' },
            createdAt: { type: 'string', format: 'date-time' },
            actor: {
              type: 'object',
              properties: { displayName: { type: 'string' }, email: { type: 'string' } },
            },
            target: {
              type: 'object',
              properties: { displayName: { type: 'string' }, email: { type: 'string' } },
            },
          },
        },
        AvatarResponse: {
          type: 'object',
          properties: { avatarUrl: { type: 'string', nullable: true } },
        },
      },
    },
    tags: [
      { name: 'Auth', description: 'Authentication endpoints' },
      { name: 'Users', description: 'User profile & badges' },
      { name: 'Admin', description: 'Admin & moderator endpoints' },
      { name: 'System', description: 'Health & documentation' },
    ],
  },
  apis: ['./src/routes/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
