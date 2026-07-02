const swaggerJSDoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'MOS API',
      version: '0.1.0',
      description: 'System Management API for MOS',
      contact: {
        name: 'MOS Team'
      }
    },
    tags: [

      {
        name: 'Authentication',
        description: 'User authentication and management'
      },
      {
        name: 'Disks',
        description: 'Disk and Storage Management'
      },
      {
        name: 'SMART',
        description: 'SMART Monitoring Configuration and Status'
      },
      {
        name: 'Disks WebSocket',
        description: 'Real-time disk monitoring via WebSocket'
      },
      {
        name: 'Pools',
        description: 'Storage Pool Management'
      },
      {
        name: 'Pools WebSocket',
        description: 'Real-time pool monitoring via WebSocket'
      },
      {
        name: 'iSCSI Targets',
        description: 'iSCSI Target Management'
      },
      {
        name: 'iSCSI Initiators',
        description: 'iSCSI Initiator Management'
      },
      {
        name: 'Docker',
        description: 'Docker Container Management'
      },
      {
        name: 'Docker Compose',
        description: 'Docker Compose Stack Management'
      },
      {
        name: 'Docker WebSocket',
        description: 'Real-time Docker operations via WebSocket'
      },
      {
        name: 'LXC',
        description: 'LXC Container Management'
      },
      {
        name: 'LXC WebSocket',
        description: 'Real-time LXC container monitoring via WebSocket'
      },
      {
        name: 'VM',
        description: 'Virtual Machine Management with libvirt/QEMU'
      },
      {
        name: 'VM WebSocket',
        description: 'Real-time VM monitoring via WebSocket'
      },
      {
        name: 'Users',
        description: 'SMB Users and System User Management'
      },
      {
        name: 'Shares',
        description: 'Network Shares Management (SMB/CIFS)'
      },
      {
        name: 'Remotes',
        description: 'Remote Shares Management (SMB/NFS Mount)'
      },
      {
        name: 'Cron',
        description: 'Cron Jobs Management'
      },
      {
        name: 'System',
        description: 'System Information, Monitoring and Power Management'
      },
      {
        name: 'System Load WebSocket',
        description: 'Real-time system load monitoring via WebSocket'
      },
      {
        name: 'MOS',
        description: 'MOS System Configuration and Settings Management'
      },
      {
        name: 'File Operations WebSocket',
        description: 'File Operations WebSocket'
      },
      {
        name: 'MOS Hub',
        description: 'MOS Hub Repository Management'
      },
      {
        name: 'MOS Plugins',
        description: 'MOS Plugin Management'
      },
      {
        name: 'Terminal',
        description: 'Terminal Management'
      },
      {
        name: 'Terminal WebSocket',
        description: 'Terminal WebSocket management and documentation'
      },
      {
        name: 'Notifications',
        description: 'Notifications Management'
      },
      {
        name: 'LLM',
        description: 'LLM Integration and Chat'
      }
    ],
    servers: [
        {
          url: '/api/v1',
          description: 'Current Host (relative)'
        },
        {
        url: 'http://{host}:998/api/v1',
        description: 'Custom Host',
        variables: {
          host: {
            default: 'localhost',
            description: 'API Host'
          }
        }
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Use POST /auth/login to get a token, then enter it here as: Bearer {your_token}'
        }
      }
    },
    security: [
      {
        bearerAuth: []
      }
    ]
  },
  apis: ['./src/routes/*.js', './src/routes/websocket/*.js']
};

const specs = swaggerJSDoc(options);

module.exports = specs;
